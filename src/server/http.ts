import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import { createMcpHandler, type McpServerFactory } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { Audit } from '../audit/index.ts';
import type { Env, Principal, TokenStore } from '../auth/index.ts';
import { UNAUTHORIZED_BODY, WWW_AUTHENTICATE, authenticate } from './auth.ts';
import { refuse, text, type Refusal } from './guards.ts';
import { METHOD_LABEL, setSafe, withSpan, type Telemetry } from '../telemetry/index.ts';
import type { RateLimiter } from './rate-limit.ts';

export interface HttpServerOptions {
  store: TokenStore;
  audit: Audit;
  env: Env;
  hosts: string[];
  origins: string[];
  maxBodyBytes: number;
  drainMs: number;
  factory: McpServerFactory;
  limiter: RateLimiter;
  now?: () => number;
  onerror?: (e: Error) => void;
  /** absent = no spans, no metrics */
  telemetry?: Telemetry;
  /** duration clock in ms; must not step backwards */
  monotonic?: () => number;
  /** test seam for the drain timer */
  timer?: typeof setTimeout;
}
export interface HttpServer {
  listen(port: number, host?: string): Promise<{ port: number }>;
  close(): Promise<void>;
  setReady(ready: boolean): void;
  readonly server: Server;
}

// WHATWG URL reports an IPv6 hostname with brackets; accept the allowlist bare or already bracketed
const bracket = (h: string) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);
const send = (res: ServerResponse, r: Refusal) => void res.writeHead(r.status, r.headers).end(r.body);
export const TOO_MANY_BODY = 'too many requests';

export function createHttpServer(o: HttpServerOptions): HttpServer {
  const now = o.now ?? Date.now;
  const monotonic = o.monotonic ?? (() => performance.now());
  const tel = o.telemetry;
  // Only a fixed message and the error's class name leave here: SDK/URL errors can carry the request target or body in enumerable props.
  const report = o.onerror ?? (() => undefined);
  const onerror = (e: unknown) => report(new Error(`request failed: ${e instanceof Error ? e.name : 'unknown'}`));
  const handler = createMcpHandler(o.factory, { responseMode: 'json', legacy: 'stateless', maxRequestBodySize: o.maxBodyBytes, onerror });
  const mcp = toNodeHandler(handler, { maxRequestBodySize: o.maxBodyBytes, onerror });
  const hostOk = hostHeaderValidation(o.hosts.map(bracket));
  const originOk = originValidation(o.origins.map(bracket));
  let ready = true;
  let inflight = 0;
  let idle: (() => void) | undefined;
  let closing: Promise<void> | undefined;

  const fail = (e: unknown, res: ServerResponse) => {
    onerror(e);
    if (!res.headersSent) send(res, text(500, 'internal error'));
    else res.destroy();
  };

  // Order is binding: health, Host, Origin, path, method, declared size, auth, handler. Guard refusals are not audited and not spanned.
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = monotonic();
    // every request except the health probes lands in the duration histogram, with a fixed route label
    const measure = () => tel && res.once('close', () => tel.instruments.httpDuration.record((monotonic() - t0) / 1000, { 'http.request.method': METHOD_LABEL(req.method), 'http.response.status_code': res.statusCode, 'http.route': '/mcp' }));
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      measure();
      return send(res, text(400, 'bad request')); // fixed body: never echo the request target
    }
    if (path === '/healthz') return send(res, text(200, 'ok'));
    if (path === '/readyz') return send(res, ready ? text(200, 'ok') : text(503, 'not ready'));
    measure();
    if (!hostOk(req, res) || !originOk(req, res)) return;
    const refusal = refuse({ method: req.method, url: req.url, contentLength: req.headers['content-length'] }, o.maxBodyBytes);
    if (refusal) return send(res, refusal);
    if (!tel) return handle(req, res);
    // the incoming traceparent is never read: every request is a root span sampled by our own ratio
    return withSpan(tel.tracer, 'POST /mcp', SpanKind.SERVER, { 'http.request.method': METHOD_LABEL(req.method), 'http.route': '/mcp' }, async (span) => {
      try {
        await handle(req, res, span);
      } catch (e) {
        fail(e, res);
        setSafe(span, { 'error.type': 'error' });
        span.setStatus({ code: SpanStatusCode.ERROR });
      } finally {
        setSafe(span, { 'http.response.status_code': res.statusCode });
      }
    }, () => 'error');
  }

  async function handle(req: IncomingMessage, res: ServerResponse, span?: Span): Promise<void> {
    const a = authenticate(req.headers.authorization, o.store, now());
    if (!a.ok) {
      o.audit.record({ tool: 'auth', env: o.env, outcome: 'denied', reason: a.code, durationMs: 0 });
      tel?.instruments.authRejections.add(1, { reason: a.code });
      if (span) setSafe(span, { 'error.type': a.code });
      return send(res, { status: 401, headers: { 'WWW-Authenticate': WWW_AUTHENTICATE, 'Content-Type': 'application/json' }, body: UNAUTHORIZED_BODY });
    }
    const principal = a.authInfo.extra?.principal as Principal;
    const lim = o.limiter.take(principal.userId);
    if (!lim.ok) {
      o.audit.record({ principal, tool: '-', env: o.env, outcome: 'denied', reason: 'rate_limited', durationMs: 0 });
      tel?.instruments.rateLimited.add(1);
      if (span) setSafe(span, { 'error.type': 'rate_limited' });
      return send(res, text(429, TOO_MANY_BODY, { 'Retry-After': String(lim.retryAfterS) }));
    }
    (req as IncomingMessage & { auth?: unknown }).auth = a.authInfo;
    await mcp(req, res);
  }

  const server = createServer({ requireHostHeader: false }, (req, res) => {
    inflight++;
    res.once('close', () => {
      if (--inflight === 0) idle?.();
    });
    route(req, res).catch((e: unknown) => fail(e, res));
  });

  return {
    server,
    setReady: (r) => void (ready = r),
    listen: (port, host = '127.0.0.1') => {
      if (closing) return Promise.reject(new Error('server is closed'));
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve({ port: (server.address() as { port: number }).port });
        });
      });
    },
    close: () => (closing ??= (async () => {
      ready = false;
      const stopped = server.listening ? new Promise<void>((r) => server.close(() => r())) : Promise.resolve();
      server.closeIdleConnections();
      if (inflight > 0 && o.drainMs > 0) {
        await new Promise<void>((r) => {
          const t = (o.timer ?? setTimeout)(r, o.drainMs);
          idle = () => (clearTimeout(t), r());
        });
      }
      await handler.close();
      server.closeAllConnections();
      await stopped;
    })()),
  };
}

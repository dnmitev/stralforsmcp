import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createMcpHandler, type McpServerFactory } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { Audit } from '../audit/index.ts';
import type { Env, TokenStore } from '../auth/index.ts';
import { UNAUTHORIZED_BODY, WWW_AUTHENTICATE, authenticate } from './auth.ts';
import { refuse, type Refusal } from './guards.ts';

export interface HttpServerOptions {
  store: TokenStore;
  audit: Audit;
  env: Env;
  hosts: string[];
  origins: string[];
  maxBodyBytes: number;
  drainMs: number;
  factory: McpServerFactory;
  now?: () => number;
  onerror?: (e: Error) => void;
  /** test seam for the drain timer */
  timer?: typeof setTimeout;
}
export interface HttpServer {
  listen(port: number, host?: string): Promise<{ port: number }>;
  close(): Promise<void>;
  setReady(ready: boolean): void;
  readonly server: Server;
}

// WHATWG URL reports an IPv6 hostname with brackets; the allowlist is written bare (::1)
const bracket = (h: string) => (h.includes(':') ? `[${h}]` : h);
const send = (res: ServerResponse, r: Refusal) => void res.writeHead(r.status, r.headers).end(r.body);
const plain = (status: number, body: string): Refusal => ({ status, headers: { 'Content-Type': 'text/plain' }, body });

export function createHttpServer(o: HttpServerOptions): HttpServer {
  const now = o.now ?? Date.now;
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

  // Order is binding: health, Host, Origin, path, method, declared size, auth, handler. Guard refusals are not audited.
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/healthz') return send(res, plain(200, 'ok'));
    if (path === '/readyz') return send(res, ready ? plain(200, 'ok') : plain(503, 'not ready'));
    if (!hostOk(req, res) || !originOk(req, res)) return;
    const refusal = refuse({ method: req.method, url: req.url, contentLength: req.headers['content-length'] }, o.maxBodyBytes);
    if (refusal) return send(res, refusal);
    const a = authenticate(req.headers.authorization, o.store, now());
    if (!a.ok) {
      o.audit.record({ tool: 'auth', env: o.env, outcome: 'denied', reason: a.code, durationMs: 0 });
      return send(res, { status: 401, headers: { 'WWW-Authenticate': WWW_AUTHENTICATE, 'Content-Type': 'application/json' }, body: UNAUTHORIZED_BODY });
    }
    (req as IncomingMessage & { auth?: unknown }).auth = a.authInfo;
    await mcp(req, res);
  }

  const server = createServer({ requireHostHeader: false }, (req, res) => {
    inflight++;
    res.once('close', () => {
      if (--inflight === 0) idle?.();
    });
    route(req, res).catch((e: unknown) => {
      onerror(e);
      if (!res.headersSent) send(res, plain(500, 'internal error'));
      else res.destroy();
    });
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

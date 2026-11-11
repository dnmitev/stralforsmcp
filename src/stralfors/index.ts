import { z } from 'zod';
import { serverInfo } from '../server-info.ts';
import type { Config } from './config.ts';
import { ConfigError, StralforsError, SchemaError, WriteBlockedError, mapHttpError } from './errors.ts';
import { createAgent, isAllowed, send } from './http.ts';
import { createLogger, type Logger } from './log.ts';
import { operations } from './operations.ts';
import { createTokenSource, type Token } from './token.ts';

export * from './config.ts';
export * from './errors.ts';
export * from './log.ts';
export * from './operations.ts';
export { createAgent, isAllowed } from './http.ts';
export { Claims, Token, parseClaims, type TokenSource } from './token.ts';

export interface CreateClientOptions {
  config: Config;
  profileId: string;
  /** test seams, never read from env */
  ca?: string;
  baseUrl?: string;
  logger?: Logger;
  onBlocked?: (e: { profile: string; method: string; pathTemplate: string }) => void;
  /** clock in ms */
  now?: () => number;
  /** wraps one upstream request (after the write guard, including the token fetch and the 401 retry); default runs it as is. Keeps the client free of telemetry imports. */
  // ponytail: not generic (R32 sketches <T>): vi.fn() mocks lose generics and would not typecheck; the client casts the result back
  instrument?: (info: InstrumentInfo, run: () => Promise<unknown>) => Promise<unknown>;
}
export interface InstrumentInfo { operation: string; method: string }
// unanchored on purpose: an id hidden inside a segment (encoded separator, prefix) is still masked
const ID_SEGMENT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{6,}/i;
interface RequestOpts<T> { schema?: z.ZodType<T>; query?: Record<string, string>; operation?: string }

export function createClient(o: CreateClientOptions) {
  const { config } = o;
  const profile = config.profiles[o.profileId];
  if (!profile) throw new ConfigError(`unknown profile ${o.profileId}`);
  const base = o.baseUrl ?? config.baseUrl;
  const log = o.logger ?? createLogger({ level: 'silent' });
  const now = o.now ?? Date.now;
  const instrument = o.instrument ?? ((_i, run) => run());
  const agent = createAgent(profile, { ca: o.ca });
  const limits = { timeoutMs: config.timeoutMs, maxBytes: config.maxBodyBytes };
  const token = createTokenSource({ profile, agent, url: new URL('/v1/oidc/token', base), env: config.env, marginS: config.tokenRefreshMarginS, now, log, ...limits });
  const policy = { env: config.env, allowWrite: config.allowWrite, prodValidateEnabled: config.prodValidateEnabled };

  async function request<T>(method: string, path: string, body: unknown, opts: RequestOpts<T> = {}): Promise<T> {
    const query = Object.entries(opts.query ?? {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const target = query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path;
    const [p, q] = target.split('?');
    // ids in a path segment or query key (UUIDs, long digit runs) must not reach logs, errors or onBlocked; query values are always masked
    const hide = (s: string) => {
      try {
        return ID_SEGMENT.test(s) || ID_SEGMENT.test(decodeURIComponent(s)) ? '*' : s;
      } catch {
        return '*'; // malformed percent-encoding: do not echo it
      }
    };
    const clean = p!.split('/').map(hide).join('/');
    const pathTemplate = q ? `${clean}?${q.split('&').map((kv) => `${hide(kv.split('=')[0]!)}=*`).join('&')}` : clean;
    method = method.toUpperCase();
    const operation = opts.operation ?? `${method} ${pathTemplate}`;
    const ctx = { profile: profile!.id, operation };
    const url = new URL(target, base);
    if (!path.startsWith('/') || url.origin !== new URL(base).origin || !/^\/(rest|v1\/oidc)\//.test(url.pathname)) throw new ConfigError('path not allowed');
    if (!isAllowed(policy, method, url.pathname + url.search)) {
      log.warn({ profile: ctx.profile, method, pathTemplate }, 'write.blocked');
      o.onBlocked?.({ profile: ctx.profile, method, pathTemplate });
      throw new WriteBlockedError(`${method} ${pathTemplate} is blocked by the write guard`, ctx);
    }
    return instrument({ operation: opts.operation ?? 'raw', method }, async (): Promise<T> => {
    const started = now();
    try {
      const attempt = (t: Token) =>
        send(agent, url, {
          method, body: JSON.stringify(body), ...limits,
          headers: {
            authorization: `Bearer ${t.bearer()}`, accept: 'application/json', 'user-agent': `${serverInfo.name}/${serverInfo.version}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
        });
      const used = await token.get();
      let res = await attempt(used);
      if (res.status === 401) {
        token.invalidate(used);
        const fresh = await token.get();
        res = await attempt(fresh);
        if (res.status === 401) token.invalidate(fresh);
      }
      if (res.status < 200 || res.status > 299) {
        const h = (n: string) => [res.headers[n]].flat()[0];
        throw mapHttpError({ status: res.status, contentType: h('content-type'), body: res.body, retryAfter: h('retry-after') }, ctx);
      }
      let json: unknown;
      try {
        json = res.body ? JSON.parse(res.body) : undefined;
      } catch {
        throw new SchemaError('response is not JSON', { ...ctx, issues: [{ path: '' }] });
      }
      const result = (opts.schema ?? (z.unknown() as z.ZodType<T>)).safeParse(json);
      if (!result.success) throw new SchemaError('response does not match the expected schema', { ...ctx, issues: result.error.issues.map((i) => ({ path: i.path.join('.') })) });
      log.info({ ...ctx, method, pathTemplate, status: res.status, durationMs: now() - started, bytes: res.bytes }, 'request');
      return result.data;
    } catch (e) {
      if (e instanceof StralforsError) {
        e.profile ??= ctx.profile;
        e.operation ??= operation;
        log.warn({ ...ctx, method, pathTemplate, status: e.status, durationMs: now() - started, kind: e.kind, traceId: e.traceId }, 'request.failed');
      }
      throw e;
    }
    }) as Promise<T>;
  }

  const core = {
    token,
    get: <T = unknown>(path: string, opts?: RequestOpts<T>) => request('GET', path, undefined, opts),
    put: <T = unknown>(path: string, body: unknown, opts?: RequestOpts<T>) => request('PUT', path, body, opts),
    post: <T = unknown>(path: string, body?: unknown, opts?: RequestOpts<T>) => request('POST', path, body, opts),
    delete: <T = unknown>(path: string, opts?: RequestOpts<T>) => request('DELETE', path, undefined, opts),
    close: () => agent.close(),
  };
  return { ...core, ...operations(core) };
}
export type StralforsClient = ReturnType<typeof createClient>;

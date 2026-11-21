import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Dispatcher } from 'undici';
import { z } from 'zod';
import { serverInfo } from '../server-info.ts';
import type { Config, Profile } from './config.ts';
import { currentSignal } from './abort.ts';
import type { UpstreamLimit } from './limit.ts';
import { BusyError, CancelledError, ConfigError, StralforsError, SchemaError, WriteBlockedError, mapHttpError } from './errors.ts';
import { createAgent as defaultCreateAgent, isAllowed, send } from './http.ts';
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
  /** cert hot-swap seams (same shape as createTokenStore); the default timer is an unref'd interval of config.certReloadS */
  readFile?: (path: string) => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  createAgent?: typeof defaultCreateAgent;
  /** called with ok only: true after a swap, false on every failing tick, never for an unchanged tick; a throw or a rejected promise is swallowed */
  onCredentialReload?: (r: { ok: boolean }) => void;
  /** shared per-pod cap on concurrent upstream requests (token fetches excluded); unset means unlimited */
  upstreamLimit?: UpstreamLimit;
}
export interface InstrumentInfo { operation: string; method: string }
// unanchored on purpose: an id hidden inside a segment (encoded separator, prefix) is still masked
const ID_SEGMENT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{6,}/i;
/** `noReplay`: on a 401 invalidate the token but never send the request a second time (a request that starts something must not be duplicated). */
interface RequestOpts<T> { schema?: z.ZodType<T>; query?: Record<string, string>; operation?: string; noReplay?: boolean }

/** validToDate comes from a native conversion whose failure is not reported as an exception: refuse a non-finite or non-positive time */
function expiryOf(c: X509Certificate): number {
  const t = c.validToDate.getTime();
  if (!Number.isFinite(t) || t <= 0) throw new Error('bad notAfter');
  return t;
}

export function createClient(o: CreateClientOptions) {
  const { config } = o;
  const profile = config.profiles[o.profileId];
  if (!profile) throw new ConfigError(`unknown profile ${o.profileId}`);
  const base = o.baseUrl ?? config.baseUrl;
  const log = o.logger ?? createLogger({ level: 'silent' });
  const now = o.now ?? Date.now;
  const instrument = o.instrument ?? ((_i, run) => run());
  const make = o.createAgent ?? defaultCreateAgent;
  let certExpiresAt: number;
  try {
    certExpiresAt = expiryOf(new X509Certificate(profile.cert.trim())); // before the agent: a bad mounted cert is a fixed-text config error, never a parser message
  } catch {
    throw new ConfigError('client certificate is not a valid PEM certificate');
  }
  let agent: Dispatcher = make(profile, { ca: o.ca });
  const readFile = o.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  // Stryker disable next-line MethodExpression: equivalent, loadConfig already trims all three values, so trim() here is defensive only
  let current = { cert: profile.cert.trim(), key: profile.key.trim(), passphrase: profile.passphrase?.trim() };
  let closed = false;
  let lastFailure: string | undefined;
  /** One tick: re-read the files; swap the agent only when the content changed and the new material loads. Failures keep the last good agent. */
  // ponytail: content compare, not mtime; one interval per client, so N profiles poll N times (cheap: three small files each)
  const report = (ok: boolean) => {
    try {
      // Stryker disable next-line OptionalChaining: equivalent, calling an absent sink throws a TypeError that the surrounding catch swallows
      void Promise.resolve(o.onCredentialReload?.({ ok })).catch(() => undefined); // a sink that returns a rejecting promise must not become an unhandled rejection
    } catch { /* a broken sink must not break the tick */ }
  };
  function reloadCredentials(): void {
    if (closed) return;
    let kind: 'read' | 'empty' | 'pem' | 'key' | undefined;
    try {
      const { cert, key, passphrase } = profile!.files;
      const next = { cert: readFile(cert).trim(), key: readFile(key).trim(), passphrase: passphrase === undefined ? undefined : readFile(passphrase).trim() };
      if (!next.cert || !next.key || next.passphrase === '') kind = 'empty';
      else if (next.cert !== current.cert || next.key !== current.key || next.passphrase !== current.passphrase) {
        let privateKey;
        let expiresAt = 0;
        try {
          privateKey = createPrivateKey({ key: next.key, passphrase: next.passphrase });
        } catch {
          kind = 'key';
        }
        // createAgent checks the key only, so the cert is parsed here and must belong to the key
        if (privateKey) {
          try {
            const x509 = new X509Certificate(next.cert);
            expiresAt = expiryOf(x509);
            if (!x509.checkPrivateKey(privateKey)) kind = 'key';
          } catch {
            kind = 'pem';
          }
        }
        if (!kind) {
          const old = agent;
          agent = make({ id: profile!.id, ...next } as Profile, { ca: o.ca });
          current = next;
          certExpiresAt = expiresAt;
          report(true);
          void old.close().catch(() => undefined); // close, never destroy: in-flight requests finish
        }
      }
    } catch {
      kind = 'read';
    }
    if (kind) report(false);
    if (kind && kind !== lastFailure) log.warn({ profile: profile!.id, kind }, 'credentials.reload_failed');
    lastFailure = kind;
  }
  const setTimer = o.setTimer ?? ((fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref();
    return h;
  });
  const clearTimer = o.clearTimer ?? ((h) => clearInterval(h as NodeJS.Timeout));
  const timer = setTimer(reloadCredentials, config.certReloadS * 1000);
  const limits = { timeoutMs: config.timeoutMs, maxBytes: config.maxBodyBytes };
  const token = createTokenSource({ profile, agent: () => agent, url: new URL('/v1/oidc/token', base), env: config.env, marginS: config.tokenRefreshMarginS, now, log, ...limits });
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
    // a tracking document id is short and alphanumeric, so ID_SEGMENT does not catch it
    // a channel lookup correlation id is vendor-chosen, so it is masked by position, whatever it looks like
    const clean = p!.split('/').map(hide).join('/').replace(/\/document\/[^/]+\/documentinfohistory$/, '/document/*/documentinfohistory').replace(/\/channellookup\/v1\/lookup\/[^/]+$/, '/channellookup/v1/lookup/*');
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
    let acquired = false;
    try {
      const signal = currentSignal();
      if (signal?.aborted) throw new CancelledError('request cancelled by the caller', ctx); // before any token fetch or socket
      if (o.upstreamLimit && !(acquired = o.upstreamLimit.tryAcquire())) throw new BusyError('upstream busy, try again shortly', ctx);
      const attempt = (t: Token) =>
        send(agent, url, {
          method, body: JSON.stringify(body), ...limits, signal,
          headers: {
            authorization: `Bearer ${t.bearer()}`, accept: 'application/json', 'user-agent': `${serverInfo.name}/${serverInfo.version}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
        });
      const used = await token.get();
      let res = await attempt(used);
      if (res.status === 401) {
        token.invalidate(used);
        if (!opts.noReplay) {
          const fresh = await token.get();
          res = await attempt(fresh);
          if (res.status === 401) token.invalidate(fresh);
        }
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
        // the heartbeat's error body is vendor-supplied and probed on a timer: its traceId is not logged
        // the heartbeat probes every interval and main.ts logs the upstream.down transition once, so its failures are debug, not a warn per round
        log[operation === 'healthV1' ? 'debug' : 'warn']({ ...ctx, method, pathTemplate, status: e.status, durationMs: now() - started, kind: e.kind, traceId: operation === 'healthV1' ? undefined : e.traceId }, 'request.failed');
      }
      throw e;
    } finally {
      if (acquired) o.upstreamLimit!.release(); // every path: success, error, timeout, cancel
    }
    }) as Promise<T>;
  }

  const core = {
    token,
    get: <T = unknown>(path: string, opts?: RequestOpts<T>) => request('GET', path, undefined, opts),
    put: <T = unknown>(path: string, body: unknown, opts?: RequestOpts<T>) => request('PUT', path, body, opts),
    post: <T = unknown>(path: string, body?: unknown, opts?: RequestOpts<T>) => request('POST', path, body, opts),
    delete: <T = unknown>(path: string, opts?: RequestOpts<T>) => request('DELETE', path, undefined, opts),
    reloadCredentials,
    certExpiresAt: () => certExpiresAt,
    close: () => {
      clearTimer(timer);
      closed = true;
      return agent.close();
    },
  };
  return { ...core, ...operations(core) };
}
export type StralforsClient = ReturnType<typeof createClient>;

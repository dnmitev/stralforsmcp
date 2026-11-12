import type { Dispatcher } from 'undici';
import { z } from 'zod';
import type { Profile } from './config.ts';
import { AuthError, SchemaError, TokenFormatError, mapHttpError } from './errors.ts';
import { send } from './http.ts';
import type { Logger } from './log.ts';

type Payload = Record<string, unknown>;
// Stryker disable next-line Regex: /\s/ vs /\s+/ differ only by empty pieces, which filter(Boolean) drops
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : []);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

/** Decoded JWT payload. The raw payload (`sub`, `customer`, ...) is private: never serialised, logged or inspected. */
export class Claims {
  readonly scopes: string[];
  readonly exp?: number;
  readonly aud: string[];
  #p: Payload;
  constructor(p: Payload = {}) {
    this.#p = p;
    this.scopes = strings(p['scope']);
    this.exp = num(p['exp']);
    this.aud = strings(p['aud']);
  }
  get customer() {
    return typeof this.#p['customer'] === 'string' ? this.#p['customer'] : undefined;
  }
  hasScope(s: string) {
    return this.scopes.includes(s);
  }
  summary() {
    const c = this.customer;
    return { scopes: this.scopes, exp: this.exp, aud: this.aud, customerCountry: c?.slice(c.lastIndexOf('/') + 1) };
  }
  toJSON() {
    return this.summary();
  }
}

/** Reads the payload only; the signature is the API's business. */
export function parseClaims(jwt: string): Claims {
  const parts = jwt.split('.');
  try {
    if (parts.length !== 3) throw 0;
    const p: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (typeof p !== 'object' || p === null || Array.isArray(p)) throw 0;
    return new Claims(p as Payload);
  } catch {
    throw new TokenFormatError('malformed access token');
  }
}

export class Token {
  readonly claims: Claims;
  readonly expiresAt: number;
  #access: string;
  constructor(access: string, claims: Claims, expiresAt: number) {
    this.#access = access;
    this.claims = claims;
    this.expiresAt = expiresAt;
  }
  bearer() {
    return this.#access;
  }
}

export interface TokenSource {
  get(): Promise<Token>;
  invalidate(failed?: Token): void;
}

const tokenResponse = z.object({ access_token: z.string(), expires_in: z.number() });

export function createTokenSource(o: {
  profile: Profile;
  agent: () => Dispatcher;
  url: URL;
  env: 'test' | 'prod';
  marginS: number;
  timeoutMs: number;
  maxBytes: number;
  now: () => number;
  log: Logger;
}): TokenSource {
  const { profile, log, now } = o;
  let cached: Token | undefined;
  let inflight: Promise<Token> | undefined;
  let warned = false;

  async function load(): Promise<Token> {
    const basic = Buffer.from(`${profile.clientId}:${profile.clientSecret}`).toString('base64');
    const res = await send(o.agent(), o.url, {
      method: 'POST', body: 'grant_type=client_credentials', timeoutMs: Math.min(o.timeoutMs, 10_000), maxBytes: o.maxBytes,
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    });
    const ctx = { profile: profile.id, operation: 'token' };
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {}
    if (res.status === 400 || res.status === 401) {
      const error = (json as { error?: unknown } | undefined)?.error;
      throw new AuthError(`token request rejected (HTTP ${res.status})`, { ...ctx, status: res.status, detail: typeof error === 'string' ? error : undefined });
    }
    if (res.status !== 200) throw mapHttpError({ status: res.status, contentType: String(res.headers['content-type']), body: res.body }, ctx);
    const parsed = tokenResponse.safeParse(json);
    if (!parsed.success) throw new SchemaError('invalid token response', { ...ctx, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.') })) });
    const { access_token, expires_in } = parsed.data;
    let claims = new Claims();
    try {
      claims = parseClaims(access_token);
    } catch {} // opaque token: no scopes, expiry from expires_in
    const expMs = claims.exp !== undefined ? claims.exp * 1000 : undefined;
    const end = expMs !== undefined && expMs > now() ? expMs : now() + expires_in * 1000; // exp in the past means clock skew: trust expires_in
    const marginMs = Math.max(0, Math.min(o.marginS * 1000, (end - now()) / 2)); // short-lived tokens must still be cacheable
    const expiresAt = end - marginMs;
    log.info({ profile: profile.id, expiresInS: expires_in, scopesCount: claims.scopes.length, customerCountry: claims.summary().customerCountry }, 'token.fetched');
    if (o.env === 'prod' && claims.hasScope('apiomni.write') && !warned) {
      warned = true;
      log.warn({ profile: profile.id }, 'write scope present in prod; guards stay active');
    }
    return (cached = new Token(access_token, claims, expiresAt));
  }

  return {
    get() {
      if (cached && now() < cached.expiresAt) return Promise.resolve(cached);
      return (inflight ??= load().finally(() => (inflight = undefined)));
    },
    // only evict the token that got the 401: a late 401 must not drop a fresh replacement
    invalidate(failed) {
      if (!failed || cached === failed) cached = undefined;
    },
  };
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ConfigError } from '../stralfors/errors.ts';

export type Role = 'dev' | 'qa' | 'pm';
export type Env = 'test' | 'prod';
export interface Principal { userId: string; name: string; role: Role; envs: Env[] }

export type VerifyCode = 'malformed' | 'unknown' | 'expired' | 'revoked';
export type VerifyResult = { ok: true; principal: Principal } | { ok: false; code: VerifyCode };

export const TOKEN_RE = /^smcp_[A-Za-z0-9_-]{43}$/;
export const MAX_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/** SHA-256 hex (lower case) of the raw token string. */
export const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');
/** 'smcp_' + base64url of 32 random bytes. */
export const generateToken = (): string => `smcp_${randomBytes(32).toString('base64url')}`;

export interface TokenListUser { id: string; name: string; role: Role; envs: Env[] }
export interface TokenListToken { hash: string; userId: string; created: string; expires: string; revoked?: boolean }
export interface TokenList { users: TokenListUser[]; tokens: TokenListToken[] }

const date = z.iso.datetime({ offset: true });
const user = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(['dev', 'qa', 'pm']),
  envs: z.array(z.enum(['test', 'prod'])).min(1).refine((e) => new Set(e).size === e.length, 'is duplicate'),
}).strict();
const token = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  userId: z.string(),
  created: date,
  expires: date,
  revoked: z.boolean().optional(),
}).strict().superRefine((t, ctx) => {
  const span = Date.parse(t.expires) - Date.parse(t.created);
  if (span <= 0) ctx.addIssue({ code: 'custom', path: ['expires'], message: 'is not after created' });
  else if (span > MAX_TOKEN_LIFETIME_MS) ctx.addIssue({ code: 'custom', path: ['expires'], message: 'exceeds 90 days' });
});
const schema = z.object({ users: z.array(user), tokens: z.array(token) }).strict();

const where = (path: PropertyKey[]) => path.reduce<string>((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${String(k)}` : String(k)), '') || '(root)';
const fail = (path: PropertyKey[], rule: string) => new ConfigError(`token list: ${where(path)} ${rule}`);

/** Parses and cross-checks the file. Error text names the field path and rule only, never a value. */
function parse(text: string): TokenList {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw fail([], 'is invalid');
  }
  const r = schema.safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw fail(i.path, i.code === 'unrecognized_keys' ? 'has unknown key' : i.code === 'custom' ? i.message : /received undefined/.test(i.message) ? 'is required' : 'is invalid');
  }
  const ids = new Set<string>();
  r.data.users.forEach((u, n) => {
    if (ids.has(u.id)) throw fail(['users', n, 'id'], 'is duplicate');
    ids.add(u.id);
  });
  const hashes = new Set<string>();
  r.data.tokens.forEach((t, n) => {
    if (hashes.has(t.hash)) throw fail(['tokens', n, 'hash'], 'is duplicate');
    hashes.add(t.hash);
    if (!ids.has(t.userId)) throw fail(['tokens', n, 'userId'], 'references unknown user');
  });
  return r.data;
}

export interface TokenStore {
  verify(raw: string, at?: number): VerifyResult;
  reload(): void;
  close(): void;
}

export interface TokenStoreOptions {
  read: () => string;
  now: () => number;
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onReload?: (r: { ok: true; users: number; tokens: number } | { ok: false }) => void;
  log?: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
}

interface View { users: Map<string, TokenListUser>; tokens: Map<string, TokenListToken> }

export function createTokenStore(o: TokenStoreOptions): TokenStore {
  const load = (): { view: View; list: TokenList } => {
    let text: string;
    try {
      text = o.read();
    } catch {
      throw new ConfigError('token list: cannot read');
    }
    const list = parse(text);
    return { list, view: { users: new Map(list.users.map((u) => [u.id, u])), tokens: new Map(list.tokens.map((t) => [t.hash, t])) } };
  };

  let view = load().view;
  let lastFailure: string | undefined;

  function reload() {
    try {
      const next = load();
      view = next.view;
      lastFailure = undefined;
      o.onReload?.({ ok: true, users: next.list.users.length, tokens: next.list.tokens.length });
    } catch (e) {
      const text = e instanceof ConfigError ? e.message : 'unknown';
      if (text !== lastFailure) o.log?.warn({ kind: 'config' }, 'reload.failed');
      lastFailure = text;
      o.onReload?.({ ok: false });
    }
  }

  const setTimer = o.setTimer ?? ((fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref();
    return h;
  });
  const clearTimer = o.clearTimer ?? ((h) => clearInterval(h as NodeJS.Timeout));
  const handle = setTimer(reload, o.intervalMs ?? 60_000);
  let closed = false;

  return {
    verify(raw, at = o.now()) {
      if (typeof raw !== 'string' || !TOKEN_RE.test(raw)) return { ok: false, code: 'malformed' };
      const digest = hashToken(raw);
      const t = view.tokens.get(digest);
      // Map hit is already exact; the constant-time compare is defence in depth (ponytail: not the security boundary)
      if (!t || !timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(t.hash, 'hex'))) return { ok: false, code: 'unknown' };
      if (t.revoked) return { ok: false, code: 'revoked' };
      if (at >= Date.parse(t.expires)) return { ok: false, code: 'expired' };
      const u = view.users.get(t.userId)!;
      return { ok: true, principal: { userId: u.id, name: u.name, role: u.role, envs: [...u.envs] } };
    },
    reload,
    close() {
      if (closed) return;
      closed = true;
      clearTimer(handle);
    },
  };
}

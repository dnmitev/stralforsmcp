// Pure operations behind `npm run token`. Every change is re-checked with the server's own parser
// before it is returned, so a list built here is always one the server accepts.
import { ENVS, generateToken, hashToken, MAX_TOKEN_LIFETIME_MS, parseTokenList, ROLES, type Env, type Role, type TokenList, type TokenListUser } from '../auth/index.ts';
import { decide, type Access } from '../policy/index.ts';

const DAY = 86_400_000;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = MAX_TOKEN_LIFETIME_MS / DAY;
export const ID_LEN = 8;

/** Wrong operator input. Fixed text that names the flag and the allowed values, never a secret. */
export class InputError extends Error {}

export function parseRole(v: string): Role {
  if (!(ROLES as readonly string[]).includes(v)) throw new InputError(`--role must be one of: ${ROLES.join(', ')}`);
  return v as Role;
}

export function parseEnvs(vs: readonly string[]): Env[] {
  if (vs.length === 0 || vs.some((v) => !(ENVS as readonly string[]).includes(v))) throw new InputError(`--env must be one or more of: ${ENVS.join(', ')}`);
  return [...new Set(vs)] as Env[];
}

export function parseDays(v: string | undefined): number {
  if (v === undefined) return DEFAULT_DAYS;
  const d = /^\d+$/.test(v) ? Number(v) : NaN;
  if (!(d >= 1 && d <= MAX_DAYS)) throw new InputError(`--days must be a whole number from 1 to ${MAX_DAYS}`);
  return d;
}

const nonEmpty = (v: string, flag: string): string => {
  const t = v.trim();
  if (!t) throw new InputError(`${flag} must not be empty`);
  return t;
};

/** Round-trips through the server parser: throws its ConfigError (field path + rule) when invalid. */
const checked = (list: TokenList): TokenList => parseTokenList(JSON.stringify(list));

export const emptyList = (): TokenList => ({ users: [], tokens: [] });
export const tokenId = (hash: string): string => hash.slice(0, ID_LEN);

const findUser = (list: TokenList, id: string): TokenListUser => {
  const u = list.users.find((x) => x.id === id);
  if (!u) throw new InputError(`unknown user ${id}`);
  return u;
};

export function addUser(list: TokenList, u: TokenListUser): TokenList {
  const id = nonEmpty(u.id, '--id');
  const name = nonEmpty(u.name, '--name');
  if (list.users.some((x) => x.id === id)) throw new InputError(`user ${id} already exists`);
  return checked({ ...list, users: [...list.users, { id, name, role: u.role, envs: [...u.envs] }] });
}

export function setUser(list: TokenList, id: string, patch: Partial<Omit<TokenListUser, 'id'>>): TokenList {
  findUser(list, id);
  const name = patch.name === undefined ? undefined : nonEmpty(patch.name, '--name');
  return checked({
    ...list,
    users: list.users.map((u) => (u.id === id ? { ...u, ...(name && { name }), ...(patch.role && { role: patch.role }), ...(patch.envs && { envs: [...patch.envs] }) } : u)),
  });
}

export function issueToken(list: TokenList, userId: string, days: number, now: number, gen: () => string = generateToken): { list: TokenList; raw: string; id: string } {
  findUser(list, userId);
  parseDays(String(days));
  const raw = gen();
  const hash = hashToken(raw);
  const next = checked({ ...list, tokens: [...list.tokens, { hash, userId, created: new Date(now).toISOString(), expires: new Date(now + days * DAY).toISOString() }] });
  return { list: next, raw, id: tokenId(hash) };
}

export function revokeToken(list: TokenList, id: string): { list: TokenList; count: number } {
  if (id.length < ID_LEN) throw new InputError(`--token needs at least ${ID_LEN} characters`);
  const hits = list.tokens.filter((t) => t.hash.startsWith(id));
  if (hits.length === 0) throw new InputError(`no token with id ${id}`);
  if (hits.length > 1) throw new InputError(`id ${id} matches ${hits.length} tokens; use more characters`);
  return { list: checked({ ...list, tokens: list.tokens.map((t) => (t === hits[0] ? { ...t, revoked: true } : t)) }), count: 1 };
}

export function revokeUser(list: TokenList, userId: string): { list: TokenList; count: number } {
  findUser(list, userId);
  const count = list.tokens.filter((t) => t.userId === userId).length;
  return { list: checked({ ...list, tokens: list.tokens.map((t) => (t.userId === userId ? { ...t, revoked: true } : t)) }), count };
}

/**
 * Removes tokens that expired at least `olderThanDays` ago (revoked ones too). A revoked token that has not
 * expired yet stays as a trace until it expires (at most 90 days). With `users`, users left without tokens go too.
 */
export function prune(list: TokenList, o: { olderThanDays?: number; users?: boolean }, now: number): { list: TokenList; tokens: number; users: number } {
  const cutoff = now - (o.olderThanDays ?? 0) * DAY;
  const tokens = list.tokens.filter((t) => Date.parse(t.expires) > cutoff);
  const owners = new Set(tokens.map((t) => t.userId));
  const users = o.users ? list.users.filter((u) => owners.has(u.id)) : list.users;
  return { list: checked({ users, tokens }), tokens: list.tokens.length - tokens.length, users: list.users.length - users.length };
}

export type TokenState = 'active' | 'expired' | 'revoked';
export interface ListView {
  users: { id: string; name: string; role: Role; envs: Env[]; active: number }[];
  tokens: { id: string; userId: string; created: string; expires: string; state: TokenState }[];
}

const stateOf = (t: TokenList['tokens'][number], now: number): TokenState =>
  t.revoked ? 'revoked' : now >= Date.parse(t.expires) || now < Date.parse(t.created) ? 'expired' : 'active';

/** What `list` prints: token ids are hash prefixes; full hashes and raw tokens never appear. */
export function listView(list: TokenList, now: number): ListView {
  const tokens = list.tokens.map((t) => ({ id: tokenId(t.hash), userId: t.userId, created: t.created, expires: t.expires, state: stateOf(t, now) }));
  const users = list.users.map((u) => ({ id: u.id, name: u.name, role: u.role, envs: [...u.envs], active: tokens.filter((t) => t.userId === u.id && t.state === 'active').length }));
  return { users, tokens };
}

export const ACCESSES: readonly Access[] = ['read', 'validate', 'write', 'lookup'];
export interface AccessRow { role: Role; env: Env; access: Access; result: string }

const allScopes = { hasScope: () => true };

/**
 * Role x environment x tool access class, computed with the server policy (`decide`), assuming the user's `envs`
 * include that environment and the profile's Stralfors client holds the needed scopes.
 */
export function accessTable(): AccessRow[] {
  const rows: AccessRow[] = [];
  for (const role of ROLES) for (const env of ENVS) for (const access of ACCESSES) {
    const at = (allowWrite: boolean, prodValidateEnabled: boolean) =>
      decide({ principal: { userId: 'u', name: 'u', role, envs: [env] }, env, allowWrite, prodValidateEnabled, claims: allScopes, tool: { name: 't', access } });
    const base = at(false, false);
    let result: string;
    if (base.allow) result = 'yes';
    else if (access === 'write' && at(true, false).allow) result = 'only with STRALFORS_ALLOW_WRITE=true';
    else if (access === 'validate' && at(false, true).allow) result = 'only with STRALFORS_PROD_VALIDATE_ENABLED=true';
    else result = `no (${base.reason})`;
    rows.push({ role, env, access, result });
  }
  return rows;
}

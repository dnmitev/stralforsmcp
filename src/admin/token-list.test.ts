import { describe, expect, it } from 'vitest';
import { hashToken, parseTokenList, type TokenList } from '../auth/index.ts';
import {
  accessTable, addUser, DEFAULT_DAYS, emptyList, InputError, issueToken, listView, MAX_DAYS, parseDays, parseEnvs, parseRole,
  prune, revokeToken, revokeUser, setUser, tokenId,
} from './token-list.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2030-01-10T00:00:00.000Z');
let n = 0;
const gen = () => `smcp_${String(++n).padStart(43, 'A')}`;

const withUser = (id = 'alice', role: 'dev' | 'qa' | 'pm' = 'dev'): TokenList =>
  addUser(emptyList(), { id, name: 'Alice Example', role, envs: ['test'] });

describe('input validators', () => {
  it('accepts only the server roles and names them on refusal', () => {
    expect(parseRole('qa')).toBe('qa');
    expect(() => parseRole('SA')).toThrow(InputError);
    expect(() => parseRole('SA')).toThrow('--role must be one of: dev, qa, pm');
    expect(() => parseRole('Dev')).toThrow(InputError);
  });

  it('accepts a non-empty, de-duplicated subset of the server envs', () => {
    expect(parseEnvs(['test', 'prod', 'test'])).toEqual(['test', 'prod']);
    expect(() => parseEnvs([])).toThrow('--env must be one or more of: test, prod');
    expect(() => parseEnvs(['stage'])).toThrow('--env must be one or more of: test, prod');
  });

  it('bounds days to 1..90 with a 30-day default', () => {
    expect(parseDays(undefined)).toBe(DEFAULT_DAYS);
    expect(DEFAULT_DAYS).toBe(30);
    expect(parseDays('1')).toBe(1);
    expect(parseDays(String(MAX_DAYS))).toBe(90);
    for (const bad of ['0', '91', '1.5', 'x', '', '-3']) expect(() => parseDays(bad), bad).toThrow('--days must be a whole number from 1 to 90');
  });
});

describe('users', () => {
  it('adds a user that the server parser accepts', () => {
    const l = withUser();
    expect(l.users).toEqual([{ id: 'alice', name: 'Alice Example', role: 'dev', envs: ['test'] }]);
    expect(() => parseTokenList(JSON.stringify(l))).not.toThrow();
  });

  it('refuses a duplicate id, a blank id or a blank name', () => {
    expect(() => addUser(withUser(), { id: 'alice', name: 'X', role: 'qa', envs: ['test'] })).toThrow('user alice already exists');
    expect(() => addUser(emptyList(), { id: ' ', name: 'X', role: 'qa', envs: ['test'] })).toThrow('--id must not be empty');
    expect(() => addUser(emptyList(), { id: 'b', name: '  ', role: 'qa', envs: ['test'] })).toThrow('--name must not be empty');
  });

  it('refuses an invalid role even when the caller bypasses the validators', () => {
    expect(() => addUser(emptyList(), { id: 'b', name: 'B', role: 'SA' as never, envs: ['test'] })).toThrow('users[0].role is invalid');
  });

  it('changes access of an existing user without touching others', () => {
    const l = addUser(withUser(), { id: 'bob', name: 'Bob', role: 'pm', envs: ['test'] });
    const u = setUser(l, 'alice', { role: 'qa', envs: ['test', 'prod'] });
    expect(u.users[0]).toEqual({ id: 'alice', name: 'Alice Example', role: 'qa', envs: ['test', 'prod'] });
    expect(u.users[1]).toEqual(l.users[1]);
    expect(l.users[0]!.role).toBe('dev');
    expect(() => setUser(l, 'nobody', { role: 'qa' })).toThrow('unknown user nobody');
  });
});

describe('tokens', () => {
  it('issues a token: raw returned once, only its hash stored, bounded expiry', () => {
    const { list, raw, id } = issueToken(withUser(), 'alice', 30, NOW, gen);
    expect(raw).toMatch(/^smcp_/);
    const t = list.tokens[0]!;
    expect(t.hash).toBe(hashToken(raw));
    expect(id).toBe(t.hash.slice(0, 8));
    expect(t.created).toBe(new Date(NOW).toISOString());
    expect(Date.parse(t.expires) - NOW).toBe(30 * DAY);
    expect(JSON.stringify(list)).not.toContain(raw);
  });

  it('refuses an unknown user and an out-of-range lifetime', () => {
    expect(() => issueToken(withUser(), 'bob', 30, NOW, gen)).toThrow('unknown user bob');
    expect(() => issueToken(withUser(), 'alice', 91, NOW, gen)).toThrow('--days must be a whole number from 1 to 90');
  });

  it('revokes by 8-char id or by user, keeps the entry', () => {
    let l = withUser();
    const a = issueToken(l, 'alice', 30, NOW, gen);
    const b = issueToken(a.list, 'alice', 30, NOW, gen);
    l = b.list;
    const r = revokeToken(l, a.id);
    expect(r.count).toBe(1);
    expect(r.list.tokens.map((t) => t.revoked)).toEqual([true, undefined]);
    expect(revokeUser(l, 'alice').list.tokens.every((t) => t.revoked)).toBe(true);
    expect(revokeUser(l, 'alice').count).toBe(2);
    expect(() => revokeToken(l, 'ffffffff')).toThrow('no token with id ffffffff');
    expect(() => revokeUser(l, 'bob')).toThrow('unknown user bob');
  });

  it('refuses an ambiguous or too short id', () => {
    const l: TokenList = {
      users: [{ id: 'a', name: 'A', role: 'dev', envs: ['test'] }],
      tokens: [
        { hash: `abcdef12${'0'.repeat(56)}`, userId: 'a', created: '2030-01-01T00:00:00.000Z', expires: '2030-01-02T00:00:00.000Z' },
        { hash: `abcdef12${'1'.repeat(56)}`, userId: 'a', created: '2030-01-01T00:00:00.000Z', expires: '2030-01-02T00:00:00.000Z' },
      ],
    };
    expect(() => revokeToken(l, 'abcdef12')).toThrow('id abcdef12 matches 2 tokens; use more characters');
    expect(revokeToken(l, `abcdef12${'1'.repeat(4)}`).count).toBe(1);
    expect(() => revokeToken(l, 'abc')).toThrow('--token needs at least 8 characters');
  });

  it('prunes tokens expired at least N days ago, and users only on request', () => {
    let l = addUser(withUser(), { id: 'bob', name: 'Bob', role: 'qa', envs: ['test'] });
    l = issueToken(l, 'alice', 1, NOW - 10 * DAY, gen).list; // expired 9 days ago
    l = issueToken(l, 'alice', 30, NOW, gen).list; // active
    l = revokeToken(l, tokenId(l.tokens[1]!.hash)).list; // revoked, not expired: kept as a trace
    expect(prune(l, {}, NOW).tokens).toBe(1);
    expect(prune(l, { olderThanDays: 10 }, NOW).tokens).toBe(0);
    expect(prune(l, { olderThanDays: 9 }, NOW).tokens).toBe(1);
    const p = prune(l, { users: true }, NOW);
    expect(p.list.users.map((u) => u.id)).toEqual(['alice']);
    expect(p.users).toBe(1);
    expect(prune(l, {}, NOW).list.users).toHaveLength(2);
  });
});

describe('listView', () => {
  it('shows states and 8-char ids, never a full hash', () => {
    let l = withUser();
    l = issueToken(l, 'alice', 1, NOW - 2 * DAY, gen).list;
    l = issueToken(l, 'alice', 30, NOW, gen).list;
    l = issueToken(l, 'alice', 30, NOW, gen).list;
    l = revokeToken(l, tokenId(l.tokens[2]!.hash)).list;
    const v = listView(l, NOW);
    expect(v.tokens.map((t) => t.state)).toEqual(['expired', 'active', 'revoked']);
    expect(v.users[0]).toMatchObject({ id: 'alice', role: 'dev', envs: ['test'], active: 1 });
    const text = JSON.stringify(v);
    for (const t of l.tokens) expect(text).not.toContain(t.hash);
    expect(v.tokens[0]!.id).toHaveLength(8);
  });
});

describe('accessTable', () => {
  const cell = (role: string, env: string, access: string) => accessTable().find((r) => r.role === role && r.env === env && r.access === access)!.result;

  it('is derived from the policy', () => {
    expect(cell('pm', 'test', 'read')).toBe('yes');
    expect(cell('qa', 'test', 'validate')).toBe('yes');
    expect(cell('qa', 'prod', 'read')).toBe('no (role)');
    expect(cell('pm', 'prod', 'validate')).toBe('no (role)');
    expect(cell('dev', 'prod', 'read')).toBe('yes');
    expect(cell('dev', 'prod', 'write')).toBe('no (write)');
    expect(cell('dev', 'test', 'write')).toBe('only with STRALFORS_ALLOW_WRITE=true');
    expect(cell('dev', 'prod', 'validate')).toBe('only with STRALFORS_PROD_VALIDATE_ENABLED=true');
    expect(cell('dev', 'prod', 'lookup')).toBe('no (lookup)');
    expect(cell('qa', 'test', 'lookup')).toBe('yes');
    expect(accessTable()).toHaveLength(3 * 2 * 4);
  });
});

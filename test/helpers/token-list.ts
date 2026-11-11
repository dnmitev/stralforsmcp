// Builds synthetic token lists at test time. No token, digest or id is ever committed.
import { generateToken, hashToken, type TokenList, type TokenListToken, type TokenListUser } from '../../src/auth/index.ts';

export const DAY = 86_400_000;
export const T = Date.parse('2030-01-01T00:00:00.000Z');
export const iso = (ms: number) => new Date(ms).toISOString();

export interface Fixture {
  raw: { tA: string; tB: string; tC: string };
  list: TokenList;
  text: () => string;
  /** mutable file content, as the store's read() sees it */
  file: { content: string };
}

export function entry(raw: string, userId: string, o: Partial<TokenListToken> & { created?: string; expires?: string } = {}): TokenListToken {
  return { hash: hashToken(raw), userId, created: iso(T - DAY), expires: iso(T + 30 * DAY), ...o };
}

/** u1 dev [test, prod], u2 pm [test]; tA (u1 valid), tB (u2 revoked), tC (u1 expires T+1s). */
export function fixture(): Fixture {
  const raw = { tA: generateToken(), tB: generateToken(), tC: generateToken() };
  const users: TokenListUser[] = [
    { id: 'u1', name: 'User One', role: 'dev', envs: ['test', 'prod'] },
    { id: 'u2', name: 'User Two', role: 'pm', envs: ['test'] },
  ];
  const list: TokenList = {
    users,
    tokens: [entry(raw.tA, 'u1'), entry(raw.tB, 'u2', { revoked: true }), entry(raw.tC, 'u1', { expires: iso(T + 1000) })],
  };
  const file = { content: JSON.stringify(list) };
  return { raw, list, text: () => file.content, file };
}

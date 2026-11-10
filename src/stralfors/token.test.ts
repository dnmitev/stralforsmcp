/*
 * R3 token source + R4 claims. API under test:
 *   token.ts:  parseClaims(jwt: string): Claims            (throws TokenFormatError; message never echoes input)
 *              Claims { scopes: string[]; exp?: number; iat?: number; aud: string[]; customer?: string; sub?: string;
 *                       hasScope(s: string): boolean; summary(): { scopes; exp; aud; customerCountry? } }
 *              Token  { claims: Claims; expiresAt: number (ms); hasScope(s): boolean; bearer(): string }
 *                     JSON/inspect/toString of Token never reveal the access token.
 *   index.ts:  createClient({ config, profileId, ca?, baseUrl?, logger?, onBlocked?, now? }): StralforsClient
 *              - `ca`, `baseUrl` (default config.baseUrl) are test seams, never read from env.
 *              - `now: () => number` (ms) is the clock; default Date.now.
 *              - client.token: TokenSource { get(): Promise<Token>; invalidate(): void }
 *   Token with opaque (non-JWT) access_token: token.claims.scopes === [] (the source swallows TokenFormatError);
 *   expiry = now + expires_in*1000 - margin. JWT: expiry from `exp` claim - margin. Refetch when now >= expiry.
 *   Warning on first token fetch in prod when scope has apiomni.write: logger.warn msg
 *   "write scope present in prod; guards stay active" (once per client).
 *   Log events: msg "token.fetched" { profile, expiresInS, scopesCount, customerCountry }.
 */
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { z } from 'zod';
import { AuthError, TokenFormatError } from './errors.ts';
import { parseClaims } from './token.ts';
import { b64url, canary, json, makeJwt, memoryLogger, startFakeApi, testClient, type FakeApi } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

let pki: Pki;
let fake: FakeApi | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('R3 token source', () => {
  it('first call fetches, second call reuses', async () => {
    fake = await startFakeApi({ pki });
    const { client } = testClient(pki, fake);
    const [a, b] = [await client.token.get(), await client.token.get()];
    expect(fake.tokenRequests).toHaveLength(1);
    expect(b).toBe(a);
  });

  it('Basic auth and form body', async () => {
    fake = await startFakeApi({ pki });
    const { client, files } = testClient(pki, fake);
    await client.token.get();
    const r = fake.tokenRequests[0]!;
    expect(r.method).toBe('POST');
    expect(r.headers['authorization']).toBe(`Basic ${Buffer.from(`${files.clientId}:${files.clientSecret}`).toString('base64')}`);
    expect(r.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(r.body).toBe('grant_type=client_credentials');
    expect(r.body).not.toContain('scope');
  });

  it('single flight', async () => {
    fake = await startFakeApi({ pki, tokenDelayMs: 200 });
    const { client } = testClient(pki, fake);
    const all = await Promise.all(Array.from({ length: 25 }, () => client.token.get()));
    expect(fake.tokenRequests).toHaveLength(1);
    expect(new Set(all).size).toBe(1);
  });

  it('refresh before expiry', async () => {
    const t0 = Date.now();
    let clock = t0;
    fake = await startFakeApi({ pki, nowMs: t0, expiresIn: 3600 });
    const { client } = testClient(pki, fake, { now: () => clock });
    await client.token.get();
    clock = t0 + 3301_000; // 299 s before exp, inside the 300 s margin
    await client.token.get();
    expect(fake.tokenRequests).toHaveLength(2);
  });

  it('token living less than the margin is still cached', async () => {
    const t0 = Date.now();
    fake = await startFakeApi({ pki, nowMs: t0, expiresIn: 200 });
    const { client } = testClient(pki, fake, { now: () => t0 });
    await client.token.get();
    await client.token.get();
    expect(fake.tokenRequests).toHaveLength(1);
  });

  it('token outside the refresh margin is reused', async () => {
    const t0 = Date.now();
    fake = await startFakeApi({ pki, nowMs: t0, expiresIn: 301 });
    const { client } = testClient(pki, fake, { now: () => t0 });
    await client.token.get();
    await client.token.get();
    expect(fake.tokenRequests).toHaveLength(1);
  });

  it('invalidate of an already replaced token keeps the fresh one', async () => {
    fake = await startFakeApi({ pki });
    const { client } = testClient(pki, fake);
    const old = await client.token.get();
    client.token.invalidate(old);
    const fresh = await client.token.get();
    client.token.invalidate(old);
    expect(await client.token.get()).toBe(fresh);
    expect(fake.tokenRequests).toHaveLength(2);
  });

  it('token call timeout is capped at 10 s', async () => {
    fake = await startFakeApi({ pki });
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const { client } = testClient(pki, fake, { extra: { STRALFORS_TIMEOUT_MS: '60000' } });
    await client.token.get();
    expect(spy.mock.calls[0]![0]).toBe(10_000);
    spy.mockRestore();
  });

  it('invalidate forces a new fetch', async () => {
    fake = await startFakeApi({ pki });
    const { client } = testClient(pki, fake);
    await client.token.get();
    client.token.invalidate();
    await client.token.get();
    expect(fake.tokenRequests).toHaveLength(2);
  });

  it('expires_in without usable exp', async () => {
    let t = Date.now();
    fake = await startFakeApi({ pki, opaqueToken: `opaque-${canary('o')}`, expiresIn: 600 });
    const { client } = testClient(pki, fake, { now: () => t });
    const first = await client.token.get();
    expect(first.claims.scopes).toEqual([]);
    t += 299_000;
    await client.token.get();
    expect(fake.tokenRequests).toHaveLength(1);
    t += 1_000;
    await client.token.get();
    expect(fake.tokenRequests).toHaveLength(2);
  });

  it('token endpoint failure is typed', async () => {
    fake = await startFakeApi({ pki, token: (_q, res) => json(res, 401, { error: 'invalid_client' }) });
    const mem = memoryLogger();
    const { client, files } = testClient(pki, fake, { logger: mem.logger });
    const err = await client.token.get().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    const e = err as AuthError;
    expect([e.kind, e.status, e.detail]).toEqual(['auth', 401, 'invalid_client']);
    const basic = Buffer.from(`${files.clientId}:${files.clientSecret}`).toString('base64');
    expect(mem.text()).not.toContain(basic);
    expect(mem.text()).not.toContain('Basic');
  });

  it('API 401 triggers one re-auth', async () => {
    let n = 0;
    fake = await startFakeApi({ pki, api: (_q, res) => (++n === 1 ? json(res, 401, 'nope', 'text/plain') : json(res, 200, { ok: 1 })) });
    const { client } = testClient(pki, fake);
    await expect(client.get('/rest/x', { schema: z.unknown() })).resolves.toEqual({ ok: 1 });
    expect(fake.tokenRequests).toHaveLength(2);
    expect(fake.apiRequests).toHaveLength(2);
    const [first, second] = fake.apiRequests.map((r) => r.headers['authorization']);
    expect(first).toBe(`Bearer ${fake.issued[0]}`);
    expect(second).toBe(`Bearer ${fake.issued[1]}`);
  });

  it('second 401 is final', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 401, 'nope', 'text/plain') });
    const { client } = testClient(pki, fake);
    await expect(client.get('/rest/x', { schema: z.unknown() })).rejects.toBeInstanceOf(AuthError);
    expect(fake.apiRequests).toHaveLength(2);
    await client.token.get(); // the rejected fresh token was evicted, so this fetches again
    expect(fake.tokenRequests).toHaveLength(3);
  });

  it('token never appears in JSON, inspect or toString of Token', async () => {
    fake = await startFakeApi({ pki });
    const { client } = testClient(pki, fake);
    const t = await client.token.get();
    for (const s of [JSON.stringify(t), inspect(t, { depth: null }), String(t)]) expect(s).not.toContain(fake.issued[0]!);
    expect(t.bearer()).toBe(fake.issued[0]);
  });
});

describe('R4 claims', () => {
  it('array scope', () => {
    const c = parseClaims(makeJwt({ scope: ['apiomni.read', 'apiomni.write', 'openid'], exp: 1, aud: ['https://h'] }));
    expect(c.scopes).toEqual(['apiomni.read', 'apiomni.write', 'openid']);
    expect(c.hasScope('apiomni.write')).toBe(true);
    expect(c.hasScope('apiomni.admin')).toBe(false);
  });

  it('string scope', () => {
    expect(parseClaims(makeJwt({ scope: 'a.read b.write' })).scopes).toEqual(['a.read', 'b.write']);
  });

  it('malformed token', () => {
    const c = canary('tok');
    const notJson = `h.${b64url(`not json ${c}`)}.s`;
    for (const input of [c, `${c}.${c}`, notJson]) {
      let err: unknown;
      try {
        parseClaims(input);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TokenFormatError);
      expect((err as Error).message).not.toContain(c);
      expect(String(err)).not.toContain(c);
    }
  });

  it('scope summary for logs', () => {
    const sub = canary('sub');
    const customer = `https://c.example.invalid/${canary('cust')}/SE`;
    const c = parseClaims(makeJwt({ scope: ['a.read'], exp: 42, aud: ['https://h'], sub, customer }));
    const s = c.summary();
    expect(s).toEqual({ scopes: ['a.read'], exp: 42, aud: ['https://h'], customerCountry: 'SE' });
    expect(JSON.stringify(s)).not.toContain(sub);
    expect(JSON.stringify(s)).not.toContain(customer);
  });

  it('write-scope warning at startup', async () => {
    fake = await startFakeApi({ pki, claims: { scope: ['apiomni.read', 'apiomni.write'] } });
    const mem = memoryLogger();
    const { client } = testClient(pki, fake, { logger: mem.logger, extra: { STRALFORS_ENV: 'prod' } });
    await client.token.get();
    const warns = mem.lines().filter((l) => l['msg'] === 'write scope present in prod; guards stay active');
    expect(warns).toHaveLength(1);
    expect(warns[0]!['level']).toBe(40);
  });

  it('no write-scope warning in test env', async () => {
    fake = await startFakeApi({ pki, claims: { scope: ['apiomni.write'] } });
    const mem = memoryLogger();
    const { client } = testClient(pki, fake, { logger: mem.logger });
    await client.token.get();
    expect(mem.text()).not.toContain('write scope present');
  });
});

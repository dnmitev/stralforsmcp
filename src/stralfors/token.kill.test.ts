// Mutation-hardening for R3 (token source) and R4 (claims): expiry arithmetic, error mapping, claim coercion, warning payload.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuthError, ForbiddenError, AgreementNotFoundError, SchemaError, TokenFormatError, UpstreamError, type StralforsError } from './errors.ts';
import { Claims, parseClaims } from './token.ts';
import { b64url, json, makeJwt, memoryLogger, startFakeApi, testClient, type FakeApi } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

let pki: Pki;
let fake: FakeApi | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const T0 = 1_700_000_000_000;
const fail = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: unknown) => e)) as StralforsError;

describe('R3 expiry arithmetic', () => {
  const expiresAt = async (o: { expiresIn: number; claims?: Record<string, unknown>; opaque?: string }) => {
    fake = await startFakeApi({ pki, nowMs: T0, expiresIn: o.expiresIn, claims: o.claims, opaqueToken: o.opaque });
    const { client } = testClient(pki, fake, { now: () => T0 });
    const t = await client.token.get();
    await fake.close();
    fake = undefined;
    return t.expiresAt;
  };

  it('JWT exp wins over expires_in', async () => {
    expect(await expiresAt({ expiresIn: 600, claims: { exp: T0 / 1000 + 7200 } })).toBe(T0 + 7_200_000 - 300_000);
  });

  it.each([
    [599, 299_500], // margin = lifetime / 2
    [600, 300_000], // both limbs equal
    [601, 300_000], // margin cap
    [3600, 300_000],
  ])('JWT lifetime %i s expires %i ms before the end', async (life, margin) => {
    expect(await expiresAt({ expiresIn: life })).toBe(T0 + life * 1000 - margin);
  });

  it('opaque token: expires_in with halved margin when short', async () => {
    expect(await expiresAt({ expiresIn: 200, opaque: 'opaque-x' })).toBe(T0 + 100_000);
    expect(await expiresAt({ expiresIn: 3600, opaque: 'opaque-x' })).toBe(T0 + 3_300_000);
  });

  it('claims exp must be numeric to count; a string exp falls back to expires_in', async () => {
    expect(await expiresAt({ expiresIn: 3600, claims: { exp: '99' } })).toBe(T0 + 3_300_000);
  });
});

describe('R3 token endpoint errors', () => {
  const ctxOf = (e: StralforsError) => [e.profile, e.operation];

  it.each([[400, 'invalid_grant'], [401, 'invalid_client']])('HTTP %i is an AuthError with the OAuth error code', async (status, code) => {
    fake = await startFakeApi({ pki, token: (_q, res) => json(res, status, { error: code }) });
    const { client } = testClient(pki, fake);
    const e = (await fail(client.token.get())) as AuthError;
    expect(e).toBeInstanceOf(AuthError);
    expect(e.message).toBe(`token request rejected (HTTP ${status})`);
    expect([e.kind, e.status, e.detail, ...ctxOf(e)]).toEqual(['auth', status, code, 'a', 'token']);
    expect(Object.keys(e)).not.toContain('detail');
  });

  it('a rejection without a string error code has no detail and does not throw on a bad body', async () => {
    for (const body of ['<html>', { error: { x: 1 } }, { error: 5 }, {}]) {
      fake = await startFakeApi({ pki, token: (_q, res) => json(res, 401, body) });
      const { client } = testClient(pki, fake);
      const e = (await fail(client.token.get())) as AuthError;
      expect(e).toBeInstanceOf(AuthError);
      expect(e.detail).toBeUndefined();
      await fake.close();
      fake = undefined;
    }
  });

  it('other non-200 statuses go through the status table with the token context', async () => {
    fake = await startFakeApi({ pki, token: (_q, res) => json(res, 503, { traceId: 'tr' }) });
    const { client } = testClient(pki, fake);
    const e = await fail(client.token.get());
    expect(e).toBeInstanceOf(UpstreamError);
    expect([e.status, e.traceId, ...ctxOf(e)]).toEqual([503, 'tr', 'a', 'token']);
  });

  it('the token response content type reaches the mapper', async () => {
    fake = await startFakeApi({ pki, token: (_q, res) => json(res, 404, { message: "Action id 'q' not found" }) });
    const { client } = testClient(pki, fake);
    expect(await fail(client.token.get())).toBeInstanceOf(AgreementNotFoundError);
  });

  it('403 is forbidden, 201 is not accepted as a token', async () => {
    fake = await startFakeApi({ pki, token: (_q, res) => json(res, 403, {}) });
    expect(await fail(testClient(pki, fake).client.token.get())).toBeInstanceOf(ForbiddenError);
    await fake.close();
    fake = await startFakeApi({ pki, token: (_q, res) => json(res, 201, { access_token: 'a', expires_in: 60 }) });
    const e = await fail(testClient(pki, fake).client.token.get());
    expect(e).toBeInstanceOf(UpstreamError);
    expect(e.status).toBe(201);
  });

  it.each([
    [{ expires_in: 60 }, 'access_token'],
    [{ access_token: 'a', expires_in: 'x' }, 'expires_in'],
  ])('malformed 200 body %j is a SchemaError naming the field', async (body, path) => {
    fake = await startFakeApi({ pki, token: (_q, res) => json(res, 200, body) });
    const { client } = testClient(pki, fake);
    const e = (await fail(client.token.get())) as SchemaError;
    expect(e).toBeInstanceOf(SchemaError);
    expect(e.message).toBe('invalid token response');
    expect(e.issues).toEqual([{ path }]);
    expect(ctxOf(e)).toEqual(['a', 'token']);
  });

  it('a 200 that is not JSON is a SchemaError', async () => {
    fake = await startFakeApi({ pki, token: (_q, res) => json(res, 200, 'nope', 'text/plain') });
    expect(await fail(testClient(pki, fake).client.token.get())).toBeInstanceOf(SchemaError);
  });

  it('sends the accept header', async () => {
    fake = await startFakeApi({ pki });
    await testClient(pki, fake).client.token.get();
    expect(fake.tokenRequests[0]!.headers['accept']).toBe('application/json');
  });
});

describe('R3/R4 logging', () => {
  it('token.fetched carries the safe summary', async () => {
    fake = await startFakeApi({ pki, nowMs: T0, expiresIn: 1234 });
    const mem = memoryLogger();
    await testClient(pki, fake, { logger: mem.logger, now: () => T0 }).client.token.get();
    const line = mem.lines().find((l) => l['msg'] === 'token.fetched')!;
    expect(line).toMatchObject({ profile: 'a', expiresInS: 1234, scopesCount: 2, customerCountry: 'SE', level: 30 });
  });

  it('write-scope warning in prod: once per client, with the profile, after a refetch too', async () => {
    fake = await startFakeApi({ pki, claims: { scope: ['apiomni.write'] } });
    const mem = memoryLogger();
    const { client } = testClient(pki, fake, { logger: mem.logger, extra: { STRALFORS_ENV: 'prod' } });
    await client.token.get();
    client.token.invalidate();
    await client.token.get();
    expect(fake.tokenRequests).toHaveLength(2);
    const warns = mem.lines().filter((l) => l['msg'] === 'write scope present in prod; guards stay active');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ profile: 'a', level: 40 });
  });

  it('no warning in prod without the write scope', async () => {
    fake = await startFakeApi({ pki });
    const mem = memoryLogger();
    await testClient(pki, fake, { logger: mem.logger, extra: { STRALFORS_ENV: 'prod' } }).client.token.get();
    expect(mem.text()).not.toContain('write scope present');
  });
});

describe('R4 claim coercion', () => {
  const claims = (p: Record<string, unknown>) => parseClaims(makeJwt(p));

  it('array scope drops non-strings', () => {
    expect(claims({ scope: ['a', 5, null, 'b'] }).scopes).toEqual(['a', 'b']);
  });

  it('string scope splits on any whitespace run and drops empties', () => {
    expect(claims({ scope: ' a  b\tc ' }).scopes).toEqual(['a', 'b', 'c']);
  });

  it('aud may be a string, an array or junk; scope junk is empty', () => {
    expect(claims({ aud: 'https://h' }).aud).toEqual(['https://h']);
    expect(claims({ aud: ['x', 1] }).aud).toEqual(['x']);
    expect(claims({ aud: 5, scope: { a: 1 } })).toMatchObject({ aud: [], scopes: [] });
    expect(new Claims().scopes).toEqual([]);
  });

  it('exp is numeric only', () => {
    expect(claims({ exp: '5' }).exp).toBeUndefined();
    expect(claims({ exp: 5 }).exp).toBe(5);
  });

  it('customer country is the last path segment; non-string customer is ignored', () => {
    expect(claims({ customer: 'https://c.example.invalid/x/NO' }).summary().customerCountry).toBe('NO');
    expect(claims({ customer: 5 }).summary().customerCountry).toBeUndefined();
    expect(claims({}).summary().customerCountry).toBeUndefined();
    expect(claims({ customer: 'SE' }).customer).toBe('SE');
  });

  it('JSON.stringify of Claims is the summary', () => {
    const c = claims({ scope: 'a', exp: 9, aud: 'h', sub: 'subject-secret', customer: 'u/DK' });
    expect(JSON.parse(JSON.stringify(c))).toEqual({ scopes: ['a'], exp: 9, aud: ['h'], customerCountry: 'DK' });
    expect(JSON.stringify(c)).not.toContain('subject-secret');
  });

  it('exactly three segments with an object payload', () => {
    const ok = b64url('{"scope":"a"}');
    expect(parseClaims(`h.${ok}.s`).scopes).toEqual(['a']);
    for (const bad of [`h.${ok}`, `h.${ok}.s.x`, `h.${b64url('[1]')}.s`, `h.${b64url('null')}.s`, `h.${b64url('"x"')}.s`, `h.${b64url('5')}.s`]) {
      const e = (() => { try { parseClaims(bad); } catch (x) { return x as Error; } })();
      expect(e).toBeInstanceOf(TokenFormatError);
      expect((e as TokenFormatError).kind).toBe('token_format');
      expect(e!.message).toBe('malformed access token');
    }
  });
});

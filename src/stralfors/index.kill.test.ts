// Mutation-hardening for index.ts request(): path guard, write guard, headers, status window, error context, close, logging.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AuthError, ConfigError, ResponseTooLargeError, SchemaError, UpstreamError, WriteBlockedError, type StralforsError } from './errors.ts';
import { json, memoryLogger, startFakeApi, testClient, type FakeApi } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { createClient } from './index.ts';
import { loadConfig } from './config.ts';
import { makeEnv } from '../../test/helpers/api.ts';

let pki: Pki;
let fake: FakeApi | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  vi.restoreAllMocks();
  await fake?.close();
  fake = undefined;
});

const T0 = 1_700_000_000_000;
const caught = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: unknown) => e)) as StralforsError;
const ok = (_q: unknown, res: import('node:http').ServerResponse) => json(res, 200, { ok: 1 });

describe('createClient', () => {
  it('unknown profile', () => {
    const config = loadConfig(makeEnv(pki).env);
    const e = (() => { try { createClient({ config, profileId: 'zz' }); } catch (x) { return x as Error; } })();
    expect(e).toBeInstanceOf(ConfigError);
    expect(e!.message).toBe('unknown profile zz');
  });

  it('close() really closes the agent', async () => {
    fake = await startFakeApi({ pki, api: ok });
    const { client } = testClient(pki, fake);
    await client.get('/rest/x');
    await client.close();
    await expect(client.get('/rest/x')).rejects.toBeDefined();
  });

  it('client works without a logger; with a sink the call is captured as a request line', async () => {
    fake = await startFakeApi({ pki, api: ok });
    const files = makeEnv(pki);
    const client = createClient({ config: loadConfig(files.env), profileId: 'a', ca: pki.ca, baseUrl: fake.url });
    await client.get('/rest/x');
    await client.close();
    // behaviour with a sink: the same call yields a captured 'request' line (pino writes to the fd, so the default silent logger cannot be observed directly)
    const mem = memoryLogger();
    const t = testClient(pki, fake, { logger: mem.logger });
    await t.client.get('/rest/x');
    expect(mem.lines().map((l) => l['msg'])).toContain('request');
  });
});

describe('local request validation', () => {
  it('is a request_invalid error naming the fields, before any I/O', async () => {
    fake = await startFakeApi({ pki, api: ok });
    const e = await caught(testClient(pki, fake).client.validateInvoice({} as never));
    expect(e).toMatchObject({ kind: 'request_invalid', name: 'RequestValidationError' });
    expect((e as unknown as { fields: string[] }).fields).toContain('actionId');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('path guard', () => {
  it.each(['x/../rest/a', 'rest/a', '/restx/a', '/rest', '/v1/oidcx/a', '/rest/../v2/foo/rest/a', '/rest/../x', '/other/rest/a'])('%s is refused before any request', async (path) => {
    fake = await startFakeApi({ pki, api: ok });
    const { client } = testClient(pki, fake);
    const e = await caught(client.get(path));
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.message).toBe('path not allowed');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('path guard without the first regex', () => {
  it.each(['//evil', '//evil.example.invalid/rest/x', '/other', 'https://evil/rest/x', 'https://evil.example.invalid/v1/oidc/token', '/\\evil.example.invalid/rest/x', '/rest/../other'])('%s throws ConfigError, no onBlocked, no request', async (path) => {
    fake = await startFakeApi({ pki, api: ok });
    const blocked: unknown[] = [];
    const { client } = testClient(pki, fake, { onBlocked: (e) => void blocked.push(e) });
    const e = await caught(client.get(path));
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.message).toBe('path not allowed');
    expect(blocked).toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('request shape', () => {
  it('query joins with ? or & and is encoded; GET has no content-type', async () => {
    fake = await startFakeApi({ pki, api: ok });
    const { client } = testClient(pki, fake);
    await client.get('/rest/x', { query: { a: 'b c' } });
    await client.get('/rest/x?z=1', { query: { a: '2' } });
    await client.get('/rest/x');
    expect(fake.apiRequests.map((r) => r.url)).toEqual(['/rest/x?a=b%20c', '/rest/x?z=1&a=2', '/rest/x']);
    for (const r of fake.apiRequests) expect(r.headers['content-type']).toBeUndefined();
  });

  it('a body is sent as JSON with a content type; absent body sends none', async () => {
    fake = await startFakeApi({ pki, api: ok });
    const { client } = testClient(pki, fake, { extra: { STRALFORS_ALLOW_WRITE: 'true' } });
    await client.put('/rest/x', { a: 1 });
    await client.post('/rest/x');
    const [put, post] = fake.apiRequests;
    expect([put!.headers['content-type'], put!.body]).toEqual(['application/json', '{"a":1}']);
    expect([post!.headers['content-type'], post!.body]).toEqual([undefined, '']);
  });

  it('a token refetch after a 401 is kept when the retry succeeds', async () => {
    let n = 0;
    fake = await startFakeApi({ pki, api: (_q, res) => (++n === 1 ? json(res, 401, 'no', 'text/plain') : json(res, 200, { ok: 1 })) });
    const { client } = testClient(pki, fake);
    await client.get('/rest/x');
    await client.get('/rest/x');
    expect(fake.tokenRequests).toHaveLength(2);
    expect(fake.apiRequests).toHaveLength(3);
  });
});

describe('write guard', () => {
  it('blocked write: typed error, exact message, callback payload, warn line, no request', async () => {
    fake = await startFakeApi({ pki, api: ok });
    const mem = memoryLogger();
    const onBlocked = vi.fn();
    const { client } = testClient(pki, fake, { logger: mem.logger, onBlocked });
    const e = await caught(client.put('/rest/x', {}, { query: { k: 'secret-value' } }));
    expect(e).toBeInstanceOf(WriteBlockedError);
    expect(e.message).toBe('PUT /rest/x?k=* is blocked by the write guard');
    expect([e.kind, e.profile, e.operation]).toEqual(['write_blocked', 'a', 'PUT /rest/x?k=*']);
    expect(onBlocked).toHaveBeenCalledWith({ profile: 'a', method: 'PUT', pathTemplate: '/rest/x?k=*' });
    expect(mem.lines().find((l) => l['msg'] === 'write.blocked')).toMatchObject({ profile: 'a', method: 'PUT', pathTemplate: '/rest/x?k=*', level: 40 });
    expect(mem.text()).not.toContain('secret-value');
    expect(fake.requests).toHaveLength(0);
  });

  it('works without an onBlocked callback', async () => {
    fake = await startFakeApi({ pki, api: ok });
    expect(await caught(testClient(pki, fake).client.delete('/rest/x'))).toBeInstanceOf(WriteBlockedError);
  });

  it('prod blocks a non-allowlisted GET and lets an allowlisted one through', async () => {
    fake = await startFakeApi({ pki, api: ok });
    const { client } = testClient(pki, fake, { extra: { STRALFORS_ENV: 'prod' } });
    expect(await caught(client.get('/rest/x'))).toBeInstanceOf(WriteBlockedError);
    await expect(client.get('/rest/outputmanagement/apiomni/v2/apiinfo')).resolves.toEqual({ ok: 1 });
  });

  it('method is case-normalised before the guard', async () => {
    fake = await startFakeApi({ pki, api: ok });
    const { client } = testClient(pki, fake);
    expect(await caught(client.post('/rest/x', {}))).toMatchObject({ kind: 'write_blocked', operation: 'POST /rest/x' });
  });
});

describe('status window', () => {
  it.each([[200], [204], [299]])('%i is success', async (status) => {
    fake = await startFakeApi({ pki, api: (_q, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 204 ? undefined : '{"v":1}'); } });
    const { client } = testClient(pki, fake);
    await expect(client.get('/rest/x')).resolves.toEqual(status === 204 ? undefined : { v: 1 });
  });

  it.each([[300], [301], [404], [500]])('%i is an error', async (status) => {
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, status, '', 'text/plain') });
    const e = await caught(testClient(pki, fake).client.get('/rest/x'));
    expect(e.status).toBe(status);
  });

  it('retry-after and content type reach the mapper', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' }); res.end('{"traceId":"t9"}'); } });
    const e = await caught(testClient(pki, fake).client.get('/rest/x'));
    expect(e).toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000, traceId: 't9' });
  });
});

describe('schema errors', () => {
  it('non-JSON 2xx body', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 200, '<html>', 'text/html') });
    const e = (await caught(testClient(pki, fake).client.get('/rest/x'))) as SchemaError;
    expect(e).toBeInstanceOf(SchemaError);
    expect(e.message).toBe('response is not JSON');
    expect(e.issues).toEqual([{ path: '' }]);
    expect([e.profile, e.operation]).toEqual(['a', 'GET /rest/x']);
  });

  it('schema mismatch names the nested path, not the value', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 200, { a: { b: 'canary-value' } }) });
    const e = (await caught(testClient(pki, fake).client.get('/rest/x', { schema: z.object({ a: z.object({ b: z.number() }) }) }))) as SchemaError;
    expect(e.message).toBe('response does not match the expected schema');
    expect(e.issues).toEqual([{ path: 'a.b' }]);
    expect(JSON.stringify(e)).not.toContain('canary-value');
    expect([e.profile, e.operation]).toEqual(['a', 'GET /rest/x']);
  });
});

describe('error context and logging', () => {
  it('an explicit operation name replaces the default', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 500, {}) });
    const e = await caught(testClient(pki, fake).client.get('/rest/x?q=1', { operation: 'my.op' }));
    expect(e.operation).toBe('my.op');
  });

  it('the default operation is method + path template', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 500, {}) });
    expect((await caught(testClient(pki, fake).client.get('/rest/x', { query: { a: '1' } }))).operation).toBe('GET /rest/x?a=*');
  });

  it('errors keep the context they already carry (token failures stay "token")', async () => {
    fake = await startFakeApi({ pki, token: (_q, res) => json(res, 401, { error: 'invalid_client' }) });
    const e = await caught(testClient(pki, fake).client.get('/rest/x'));
    expect(e).toBeInstanceOf(AuthError);
    expect([e.profile, e.operation]).toEqual(['a', 'token']);
  });

  it('errors without context get the request context', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 200, 'x'.repeat(5000), 'text/plain') });
    const e = await caught(testClient(pki, fake, { extra: { STRALFORS_MAX_BODY_BYTES: '3000' } }).client.get('/rest/x'));
    expect(e).toBeInstanceOf(ResponseTooLargeError);
    expect([e.profile, e.operation]).toEqual(['a', 'GET /rest/x']);
  });

  it('a non-Stralfors error passes through untouched and is not logged as request.failed', async () => {
    fake = await startFakeApi({ pki, api: ok });
    const mem = memoryLogger();
    const { client } = testClient(pki, fake, { logger: mem.logger });
    const boom = new Error('plain');
    const e = await client.get('/rest/x', { schema: z.unknown().transform(() => { throw boom; }) }).then(() => undefined, (x: unknown) => x);
    expect(e).toBe(boom);
    expect('profile' in (e as object)).toBe(false);
    expect('operation' in (e as object)).toBe(false);
    expect(mem.lines().some((l) => l['msg'] === 'request.failed')).toBe(false);
  });

  it('request and request.failed lines carry exact durations and fields', async () => {
    let t = T0;
    let status = 200;
    fake = await startFakeApi({ pki, nowMs: T0, api: (_q, res) => { t += 40; json(res, status, { traceId: 'tr' }); } });
    const mem = memoryLogger();
    const { client } = testClient(pki, fake, { logger: mem.logger, now: () => t });
    await client.get('/rest/x', { query: { q: '1' } });
    status = 500;
    await caught(client.get('/rest/x'));
    const lines = mem.lines();
    expect(lines.find((l) => l['msg'] === 'request')).toMatchObject({ profile: 'a', operation: 'GET /rest/x?q=*', method: 'GET', pathTemplate: '/rest/x?q=*', status: 200, durationMs: 40, bytes: 16, level: 30 });
    expect(lines.find((l) => l['msg'] === 'request.failed')).toMatchObject({ profile: 'a', operation: 'GET /rest/x', method: 'GET', pathTemplate: '/rest/x', status: 500, durationMs: 40, kind: 'upstream', traceId: 'tr', level: 40 });
  });

  it('UpstreamError type for a 5xx', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 502, {}) });
    expect(await caught(testClient(pki, fake).client.get('/rest/x'))).toBeInstanceOf(UpstreamError);
  });
});

describe('ids in path segments', () => {
  it('are masked in write.blocked logs, onBlocked and the error operation', async () => {
    const id = randomUUID();
    fake = await startFakeApi({ pki, api: ok });
    const blocked: { pathTemplate: string }[] = [];
    const mem = memoryLogger();
    const { client } = testClient(pki, fake, { logger: mem.logger, onBlocked: (e) => void blocked.push(e) });
    const e = await caught(client.post(`/rest/agreements/${id}/1234567890`, {}));
    expect(e.kind).toBe('write_blocked');
    expect(blocked[0]!.pathTemplate).toBe('/rest/agreements/*/*');
    expect(JSON.stringify([e.operation, e.message, mem.lines()])).not.toMatch(new RegExp(`${id}|1234567890`));
  });
});

/*
 * R2 mTLS agent + R5 HTTP core + R9 PROD write guard. API under test:
 *   http.ts:   createAgent(profile: Profile, opts?: { ca?: string }): undici.Dispatcher
 *                - validates the key+passphrase EAGERLY (crypto.createPrivateKey) and throws TlsError naming only profile.id
 *                - connect: { cert, key, passphrase, ca?, rejectUnauthorized: true }, connections <= 8
 *              isAllowed(policy: { env: 'test'|'prod'; allowWrite: boolean; prodValidateEnabled: boolean },
 *                        method: string, pathWithQuery: string): boolean       (pure, no I/O)
 *   index.ts:  client.get(path, opts?: { schema?: ZodType; query?: Record<string,string> }): Promise<T>
 *              client.put(path, body, opts?) / client.post(path, body?, opts?) / client.delete(path, opts?)
 *                - schema defaults to z.unknown(); path may already carry a query string
 *                - order of checks: path guard (ConfigError "path not allowed", must start /rest/ or /v1/oidc/) ->
 *                  write guard (WriteBlockedError, onBlocked({profile, method, pathTemplate}) once, log "write.blocked") ->
 *                  token -> request. Nothing touches the network before the guards pass (token fetch included).
 *   Errors: TLS handshake/cert/alert failures (incl. TLS1.3 post-handshake alerts surfacing as ECONNRESET/alert codes)
 *           -> TlsError(kind 'tls'), also when raised by the token call. Timeout -> TimeoutError. Over cap -> ResponseTooLargeError
 *           (stream cap: destroy the socket while the body is still being sent). Schema failure -> SchemaError(issues: {path}[]).
 *   Prod allowlist: GET apiinfo, v1 manage/health, v2 invoices/{channels,templates,rules,document};
 *           PUT v2/invoices/validate only if prodValidateEnabled and query test=true. Everything else blocked in prod.
 *   Test env: POST/DELETE/PATCH blocked unless allowWrite; GET and PUT validate?test=true allowed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConfigError, ResponseTooLargeError, SchemaError, TimeoutError, TlsError, UpstreamError, WriteBlockedError } from './errors.ts';
import { createAgent, isAllowed, send } from './http.ts';
import { loadConfig } from './config.ts';
import { json, makeEnv, memoryLogger, startFakeApi, testClient, type FakeApi } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

let pki: Pki;
let fake: FakeApi | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const any = { schema: z.unknown() };
const ping = (_q: unknown, res: import('node:http').ServerResponse) => json(res, 200, { pong: true });
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe('R2 mutual TLS', () => {
  it('handshake with client certificate', async () => {
    fake = await startFakeApi({ pki, api: ping });
    const { client } = testClient(pki, fake);
    await expect(client.get('/rest/ping', any)).resolves.toEqual({ pong: true });
    expect(fake.apiRequests[0]!.peerCert).toBe(true);
    expect(fake.tokenRequests[0]!.peerCert).toBe(true);
  });

  it('missing client certificate is rejected', async () => {
    fake = await startFakeApi({ pki, api: ping });
    const { client, files } = testClient(pki, fake, { who: 'foreign' });
    const err = await rejection(client.get('/rest/ping', any));
    expect(err).toBeInstanceOf(TlsError);
    expect((err as TlsError).kind).toBe('tls');
    expect((err as TlsError).status).toBeUndefined();
    for (const secret of [files.passphrase, pki.foreignClient.key.split('\n')[1]!]) {
      expect((err as Error).message).not.toContain(secret);
      expect(String(err)).not.toContain(secret);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('wrong passphrase', () => {
    const { env } = makeEnv(pki, { id: 'test-x', passphrase: 'wrong-pass' });
    const profile = loadConfig(env).profiles['test-x']!;
    let err: unknown;
    try {
      createAgent(profile, { ca: pki.ca });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TlsError);
    expect((err as TlsError).message).toContain('test-x');
    expect((err as TlsError).message).not.toContain('wrong-pass');
  });

  it('server certificate is verified', async () => {
    fake = await startFakeApi({ pki, api: ping, serverCert: 'selfSigned' });
    const { client } = testClient(pki, fake);
    const err = await rejection(client.get('/rest/ping', any));
    expect(err).toBeInstanceOf(TlsError);
    expect(fake.apiRequests).toHaveLength(0);
  });
});

describe('R5 HTTP core', () => {
  it('bearer and headers', async () => {
    fake = await startFakeApi({ pki, api: ping });
    const { client } = testClient(pki, fake);
    await client.get('/rest/x', any);
    const h = fake.apiRequests[0]!.headers;
    expect(h['authorization']).toBe(`Bearer ${fake.issued[0]}`);
    expect(h['accept']).toBe('application/json');
    expect(h['user-agent']).toMatch(/^stralforsmcp\//);
  });

  it('PUT sends JSON content-type and body, query values are encoded', async () => {
    fake = await startFakeApi({ pki, api: ping });
    const { client } = testClient(pki, fake);
    await client.put(`${BASE}/v2/invoices/validate`, { a: 1 }, { query: { test: 'true', q: 'a b&c' } });
    const r = fake.apiRequests[0]!;
    expect(r.method).toBe('PUT');
    expect(r.url).toBe(`${BASE}/v2/invoices/validate?test=true&q=a%20b%26c`);
    expect(r.headers['content-type']).toContain('application/json');
    expect(JSON.parse(r.body)).toEqual({ a: 1 });
  });

  it('path guard', async () => {
    fake = await startFakeApi({ pki, api: ping });
    const { client } = testClient(pki, fake);
    for (const p of ['https://evil.example.invalid/rest/x', '/other', 'rest/x']) {
      const err = await rejection(client.get(p, any));
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain('path not allowed');
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('headers timeout', async () => {
    fake = await startFakeApi({ pki, api: (req, res) => (req.url === '/rest/hang' ? undefined : ping(req, res)) });
    const { client } = testClient(pki, fake, { extra: { STRALFORS_TIMEOUT_MS: '200' } });
    const started = Date.now();
    const err = await rejection(client.get('/rest/hang', any));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).kind).toBe('timeout');
    await expect(client.get('/rest/ping', any)).resolves.toEqual({ pong: true });
  });

  it('body too large', async () => {
    let closedEarly: Promise<boolean> | undefined;
    fake = await startFakeApi({
      pki,
      api: (_q, res) => {
        const total = 9 * 1024 * 1024;
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(total) });
        closedEarly = new Promise((resolve) => res.on('close', () => resolve(!res.writableFinished)));
        const pump = () => {
          while (sent < total && !res.destroyed) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          if (!res.destroyed) res.end();
        };
        pump();
      },
    });
    const { client } = testClient(pki, fake);
    const err = await rejection(client.get('/rest/big', any));
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect((err as ResponseTooLargeError).kind).toBe('too_large');
    await expect(closedEarly).resolves.toBe(true);
  });

  it('declared content-length over the cap fails before any body arrives', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => void res.writeHead(200, { 'content-length': '5000' }).flushHeaders() });
    const { client } = testClient(pki, fake, { extra: { STRALFORS_MAX_BODY_BYTES: '1000', STRALFORS_TIMEOUT_MS: '3000' } });
    const started = Date.now();
    await expect(client.get('/rest/x', any)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('socket reset after a successful response is upstream, not tls', async () => {
    fake = await startFakeApi({ pki, api: (req, res) => (req.url === '/rest/reset' ? void req.socket.destroy() : ping(req, res)) });
    const { client } = testClient(pki, fake);
    const err = await rejection(client.get('/rest/reset', any));
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).kind).toBe('upstream');
  });

  it('a non-2xx response already proves the handshake, so a later reset is upstream', async () => {
    fake = await startFakeApi({ pki, api: (req, res) => (req.url === '/rest/reset' ? void req.socket.destroy() : json(res, 404, {})) });
    const { env } = makeEnv(pki, { id: 'test-x' });
    const agent = createAgent(loadConfig(env).profiles['test-x']!, { ca: pki.ca });
    const init = { method: 'GET', headers: {}, timeoutMs: 3000, maxBytes: 1000 };
    expect((await send(agent, new URL('/rest/x', fake.url), init)).status).toBe(404);
    await expect(send(agent, new URL('/rest/reset', fake.url), init)).rejects.toBeInstanceOf(UpstreamError);
    await agent.close();
  });

  it('body cap is configurable', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 200, { pad: 'x'.repeat(2000) }) });
    const { client } = testClient(pki, fake, { extra: { STRALFORS_MAX_BODY_BYTES: '1000' } });
    await expect(client.get('/rest/x', any)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('schema mismatch', async () => {
    const key = `leak_${randomUUID()}`;
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 200, { [key]: true }) });
    const { client } = testClient(pki, fake);
    const err = await rejection(client.get('/rest/x', { schema: z.array(z.string()) }));
    expect(err).toBeInstanceOf(SchemaError);
    expect((err as SchemaError).kind).toBe('schema');
    expect((err as SchemaError).issues.length).toBeGreaterThan(0);
    expect((err as Error).message).not.toContain(key);
    expect(JSON.stringify(err)).not.toContain(key);
  });
});

const BASE = '/rest/outputmanagement/apiomni';
const reads = [
  `${BASE}/v2/apiinfo`, `${BASE}/v1/manage/health`, `${BASE}/v2/invoices/channels`, `${BASE}/v2/invoices/templates`,
  `${BASE}/v2/invoices/rules?channel=eBrevWeMail&templateStandardId=0`, `${BASE}/v2/invoices/document?channels=EDI`,
];

describe('R9 prod write guard', () => {
  type M = 'post' | 'put' | 'delete';
  it.each<[M, string, boolean]>([
    ['post', `${BASE}/v2/invoices/true`, false],
    ['post', `${BASE}/v2/invoices/false`, false],
    ['put', `${BASE}/v2/invoices/validate?test=true`, false],
    ['put', `${BASE}/v2/invoices/validate?test=false`, false],
    ['put', `${BASE}/v2/invoices/validate?test=false`, true],
    ['delete', '/rest/anything', false],
  ])('blocked in prod: %s %s (prodValidateEnabled=%s)', async (method, path, prodValidate) => {
    fake = await startFakeApi({ pki, api: ping });
    const onBlocked = vi.fn();
    const extra = { STRALFORS_ENV: 'prod', ...(prodValidate ? { STRALFORS_PROD_VALIDATE_ENABLED: 'true' } : {}) };
    const { client } = testClient(pki, fake, { onBlocked, extra });
    const err = await rejection(method === 'delete' ? client.delete(path, any) : client[method](path, {}, any));
    expect(err).toBeInstanceOf(WriteBlockedError);
    expect((err as WriteBlockedError).kind).toBe('write_blocked');
    expect(fake.requests).toHaveLength(0);
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onBlocked.mock.calls[0]![0]).toMatchObject({ method: expect.stringMatching(/^(POST|PUT|DELETE)$/i) });
  });

  it('GET outside the prod allowlist is blocked too', async () => {
    fake = await startFakeApi({ pki, api: ping });
    const onBlocked = vi.fn();
    const { client } = testClient(pki, fake, { onBlocked, extra: { STRALFORS_ENV: 'prod' } });
    await expect(client.get('/rest/anything', any)).rejects.toBeInstanceOf(WriteBlockedError);
    expect(fake.requests).toHaveLength(0);
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it('allowed reads in prod', async () => {
    fake = await startFakeApi({ pki, api: ping });
    const { client } = testClient(pki, fake, { extra: { STRALFORS_ENV: 'prod' } });
    for (const p of reads) await expect(client.get(p, any)).resolves.toEqual({ pong: true });
    expect(fake.apiRequests.map((r) => r.url)).toEqual(reads);
  });

  it('validate in prod when explicitly enabled', async () => {
    fake = await startFakeApi({ pki, api: ping });
    const onBlocked = vi.fn();
    const { client } = testClient(pki, fake, { onBlocked, extra: { STRALFORS_ENV: 'prod', STRALFORS_PROD_VALIDATE_ENABLED: 'true' } });
    await expect(client.put(`${BASE}/v2/invoices/validate?test=true`, {}, any)).resolves.toEqual({ pong: true });
    await expect(client.put(`${BASE}/v2/invoices/validate?test=false`, {}, any)).rejects.toBeInstanceOf(WriteBlockedError);
    expect(fake.apiRequests).toHaveLength(1);
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it('test env default blocks sends too', async () => {
    fake = await startFakeApi({ pki, api: ping });
    const onBlocked = vi.fn();
    const blocked = testClient(pki, fake, { onBlocked });
    await expect(blocked.client.post(`${BASE}/v2/invoices/true`, {}, any)).rejects.toBeInstanceOf(WriteBlockedError);
    expect(fake.requests).toHaveLength(0);
    const open = testClient(pki, fake, { extra: { STRALFORS_ALLOW_WRITE: 'true' } });
    await expect(open.client.post(`${BASE}/v2/invoices/true`, {}, any)).resolves.toEqual({ pong: true });
    expect(fake.apiRequests).toHaveLength(1);
  });

  it('write.blocked is logged with the path template and no query values', async () => {
    fake = await startFakeApi({ pki, api: ping });
    const mem = memoryLogger();
    const { client } = testClient(pki, fake, { logger: mem.logger, extra: { STRALFORS_ENV: 'prod' } });
    await rejection(client.put(`${BASE}/v2/invoices/validate?test=false`, {}, any));
    const line = mem.lines().find((l) => l['msg'] === 'write.blocked')!;
    expect(line).toMatchObject({ method: 'PUT', pathTemplate: `${BASE}/v2/invoices/validate?test=*` });
    expect(typeof line['profile']).toBe('string');
  });

  describe('each guard is independent (mutation target)', () => {
    const v = `${BASE}/v2/invoices/validate`;
    type Policy = Parameters<typeof isAllowed>[0];
    const pol = (env: 'test' | 'prod', allowWrite = false, prodValidateEnabled = false): Policy => ({ env, allowWrite, prodValidateEnabled });
    it.each<[string, Policy, string, string, boolean]>([
      ['prod GET allowlisted reads', pol('prod'), 'GET', reads[0]!, true],
      ['prod GET channels', pol('prod'), 'GET', reads[2]!, true],
      ['prod GET templates', pol('prod'), 'GET', reads[3]!, true],
      ['prod GET rules', pol('prod'), 'GET', reads[4]!, true],
      ['prod GET document', pol('prod'), 'GET', reads[5]!, true],
      ['prod GET health', pol('prod'), 'GET', reads[1]!, true],
      ['prod GET unknown path', pol('prod'), 'GET', '/rest/anything', false],
      ['prod GET prefix lookalike', pol('prod'), 'GET', `${BASE}/v2/apiinfo-evil`, false],
      ['prod POST', pol('prod'), 'POST', `${BASE}/v2/invoices/true`, false],
      ['prod DELETE', pol('prod'), 'DELETE', '/rest/anything', false],
      ['prod PATCH', pol('prod'), 'PATCH', reads[2]!, false],
      ['prod PUT validate default', pol('prod'), 'PUT', `${v}?test=true`, false],
      ['prod PUT validate enabled test=true', pol('prod', false, true), 'PUT', `${v}?test=true`, true],
      ['prod PUT validate enabled test=false', pol('prod', false, true), 'PUT', `${v}?test=false`, false],
      ['prod PUT validate enabled no query', pol('prod', false, true), 'PUT', v, false],
      ['prod PUT other path enabled', pol('prod', false, true), 'PUT', `${BASE}/v2/invoices/other?test=true`, false],
      ['prod POST even if allowWrite', pol('prod', true, true), 'POST', `${BASE}/v2/invoices/true`, false],
      ['test GET anything', pol('test'), 'GET', '/rest/anything', true],
      ['test POST default', pol('test'), 'POST', `${BASE}/v2/invoices/true`, false],
      ['test DELETE default', pol('test'), 'DELETE', '/rest/anything', false],
      ['test PATCH default', pol('test'), 'PATCH', '/rest/anything', false],
      ['test POST allowWrite', pol('test', true), 'POST', `${BASE}/v2/invoices/true`, true],
      ['test DELETE allowWrite', pol('test', true), 'DELETE', '/rest/anything', true],
      ['prod validate with a second question mark', pol('prod', false, true), 'PUT', `${v}?test=true?x`, false],
      ['test validate with a second question mark', pol('test'), 'PUT', `${v}?test=true?x`, false],
      ['test PUT validate test=true twice', pol('test'), 'PUT', `${v}?test=true&test=false`, false],
      ['test PUT other path default', pol('test'), 'PUT', '/rest/anything', false],
      ['test PUT other path allowWrite', pol('test', true), 'PUT', '/rest/anything', true],
      ['test HEAD default', pol('test'), 'HEAD', '/rest/anything', false],
      ['test PUT validate test=true', pol('test'), 'PUT', `${v}?test=true`, true],
    ])('%s', (_n, policy, method, path, expected) => {
      expect(isAllowed(policy, method, path)).toBe(expected);
    });
  });
});

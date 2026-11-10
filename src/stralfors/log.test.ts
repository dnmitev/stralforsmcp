/*
 * R8 logging. API under test (src/stralfors/log.ts):
 *   createLogger(opts?: { level?: string; destination?: { write(chunk: string): void } }): Logger
 *   Logger { trace|debug|info|warn|error(obj?: object, msg?: string): void; droppedKeys: number }
 *     - pino underneath, name "stralfors-client"; default level 'info' (the client uses a 'silent' logger when none is given)
 *     - allowlist of object keys: profile, operation, method, pathTemplate, status, durationMs, bytes, kind, traceId,
 *       expiresInS, scopesCount, customerCountry. Any other key is dropped and `droppedKeys` incremented.
 *     - pino redact safety net for authorization/access_token/client_secret/passphrase/key/cert/*.body
 *   Client events (msg): token.fetched, request {profile, operation, method, pathTemplate, status, durationMs, bytes},
 *     request.failed {..., kind, traceId?}, write.blocked {profile, method, pathTemplate}.
 *     pathTemplate keeps the path and replaces every query VALUE with '*': ".../channels?actionId=*".
 *   Nothing secret is ever logged or carried by an error (message/stack/toString/inspect/JSON).
 */
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from './log.ts';
import { StralforsError } from './errors.ts';
import { canary, fixture, json, memoryLogger, startFakeApi, testClient, type FakeApi } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { z } from 'zod';

let pki: Pki;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());

const B = '/rest/outputmanagement/apiomni/v2/invoices';
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe('R8 logging hygiene', () => {
  it('canary leak test', async () => {
    const c = {
      clientId: canary('clientid'), secret: canary('secret'), cert: canary('cert'), key: canary('key'),
      sub: canary('sub'), customer: canary('customer'), title: canary('title'), identity: canary('identity'), tokenErr: canary('tokerr'),
    };
    const passphrase = pki.client.passphrase;
    const keyBodyLine = pki.client.key.split('\n')[1]!;
    const secrets = [c.clientId, c.secret, passphrase, c.cert, c.key, keyBodyLine, c.sub, c.customer, c.title, c.identity, c.tokenErr];
    const files = {
      clientId: c.clientId, clientSecret: c.secret, passphrase,
      certText: `# ${c.cert}\n${pki.client.cert}`, keyText: `# ${c.key}\n${pki.client.key}`,
    };
    const g400 = randomUUID();
    const g404 = randomUUID();
    const mem = memoryLogger('trace');

    const main: FakeApi = await startFakeApi({
      pki,
      claims: { sub: c.sub, customer: `https://c.example.invalid/${c.customer}/SE` },
      api: (req, res, entry) => {
        const [path, query = ''] = req.url!.split('?');
        if (path === `${B}/channels`) {
          return query.includes('actionId=') ? json(res, 400, { type: 't', title: c.title, status: 400, errors: { actionId: ['bad'] }, traceId: '00-abc-def-00' }, 'application/problem+json') : json(res, 200, fixture('channels.json'));
        }
        if (path === `${B}/rules`) return json(res, 200, fixture('rules-ebrevwemail.json'));
        if (path === `${B}/validate`) {
          if (entry.body.includes(g400)) {
            return json(res, 400, { message: `ValidateInvoice | DtoGuid: ${randomUUID()} | identityId '${c.identity}'`, compositeFault: { faults: [{ faultCode: null, explanationText: 'Document is not valid.', paramValues: [{ param: '#2:Document.DocumentHeader.TimeStamp', value: 'Required' }] }] } });
          }
          return json(res, 404, { message: `CustomerContract was not found based on identityId '${c.clientId}' and ActionId '${g404}'.`, compositeFault: null });
        }
        if (path === '/rest/hang') return;
        return json(res, 404, 'No Mapping Rule matched', 'text/plain');
      },
    });
    const tlsBad = await startFakeApi({ pki, serverCert: 'selfSigned', api: (_q, res) => json(res, 200, {}) });
    const tokBad = await startFakeApi({ pki, token: (_q, res) => json(res, 401, { error: 'invalid_client', error_description: c.tokenErr }) });

    const mk = (srv: FakeApi, extra?: Record<string, string>) => testClient(pki, srv, { ...files, logger: mem.logger, extra }).client;
    const client = mk(main);
    const errors: unknown[] = [];
    const doc = { documentHeader: {}, invoice: {} };
    await client.channels();
    await client.rules('eBrevWeMail');
    errors.push(await rejection(client.channels(randomUUID())));
    errors.push(await rejection(client.validateInvoice({ actionId: g400, consignmentId: 'CONSIGNMENT-0001', document: doc })));
    errors.push(await rejection(client.validateInvoice({ actionId: g404, consignmentId: 'CONSIGNMENT-0001', document: doc })));
    errors.push(await rejection(client.get('/rest/nowhere', { schema: z.unknown() })));
    errors.push(await rejection(mk(tlsBad).get('/rest/x', { schema: z.unknown() })));
    errors.push(await rejection(mk(tokBad).get('/rest/x', { schema: z.unknown() })));
    errors.push(await rejection(mk(main, { STRALFORS_TIMEOUT_MS: '200' }).get('/rest/hang', { schema: z.unknown() })));
    for (const s of [main, tlsBad, tokBad]) await s.close();

    expect(errors).toHaveLength(7);
    for (const e of errors) expect(e).toBeInstanceOf(StralforsError);
    expect(errors.map((e) => (e as StralforsError).kind)).toEqual(['bad_request', 'validation_failed', 'agreement_not_found', 'route_not_found', 'tls', 'auth', 'timeout']);

    const jwts = main.issued;
    const basics = [Buffer.from(`${c.clientId}:${c.secret}`).toString('base64')];
    const haystacks = [
      mem.text(),
      ...errors.flatMap((e) => {
        const err = e as Error;
        return [
          err.message, err.stack ?? '', String(err), inspect(err, { depth: null }), JSON.stringify(err),
          JSON.stringify({ ...err }), JSON.stringify(Object.assign({}, err)), JSON.stringify(Object.keys(err).map((k) => (err as unknown as Record<string, unknown>)[k])),
        ];
      }),
    ];
    expect(mem.lines().length).toBeGreaterThan(5);
    const msgs = new Set(mem.lines().map((l) => l['msg']));
    for (const m of ['token.fetched', 'request', 'request.failed']) expect(msgs).toContain(m);
    for (const h of haystacks) {
      for (const s of [...secrets, ...jwts, ...basics]) {
        expect(h).not.toContain(s);
      }
    }
    // agreement ids may sit on an error's actionId, but are never logged
    expect(mem.text()).not.toContain(g404);
    expect(mem.text()).not.toContain(g400);
  });

  it('allowlist drops unknown keys', () => {
    const out: string[] = [];
    const log = createLogger({ level: 'info', destination: { write: (s: string) => void out.push(s) } });
    log.info({ operation: 'channels', body: 'x', foo: 1 }, 'request');
    const line = JSON.parse(out.join('').trim());
    expect(line.operation).toBe('channels');
    expect(line.name).toBe('stralfors-client');
    expect(line.msg).toBe('request');
    expect(line).not.toHaveProperty('body');
    expect(line).not.toHaveProperty('foo');
    expect(log.droppedKeys).toBe(2);
  });

  it('path template, not query values', async () => {
    const g = '11111111-1111-4111-8111-111111111111';
    const mem = memoryLogger();
    const srv = await startFakeApi({ pki, api: (_q, res) => json(res, 200, fixture('channels.json')) });
    const { client } = testClient(pki, srv, { logger: mem.logger });
    await client.channels(g);
    await srv.close();
    const line = mem.lines().find((l) => l['msg'] === 'request')!;
    expect(String(line['pathTemplate'])).toMatch(/channels\?actionId=\*$/);
    expect(mem.text()).not.toContain(g);
  });

  it('request and request.failed carry the allowlisted fields', async () => {
    const mem = memoryLogger();
    const srv = await startFakeApi({
      pki,
      api: (req, res) => (req.url === '/rest/bad' ? json(res, 404, 'No Mapping Rule matched', 'text/plain') : json(res, 200, fixture('channels.json'))),
    });
    const { client } = testClient(pki, srv, { logger: mem.logger });
    await client.get('/rest/ok', { schema: z.unknown() });
    await rejection(client.get('/rest/bad', { schema: z.unknown() }));
    await srv.close();
    const lines = mem.lines();
    const ok = lines.find((l) => l['msg'] === 'request')!;
    expect(ok).toMatchObject({ profile: 'a', method: 'GET', pathTemplate: '/rest/ok', status: 200, name: 'stralfors-client' });
    expect(typeof ok['durationMs']).toBe('number');
    expect(ok['bytes']).toBe(fixture('channels.json').length);
    const failed = lines.find((l) => l['msg'] === 'request.failed')!;
    expect(failed).toMatchObject({ profile: 'a', kind: 'route_not_found', status: 404 });
    const tok = lines.find((l) => l['msg'] === 'token.fetched')!;
    expect(tok).toMatchObject({ profile: 'a', expiresInS: 3600, scopesCount: 2, customerCountry: 'SE' });
    expect(Object.keys(tok).filter((k) => ['sub', 'customer', 'access_token', 'authorization'].includes(k))).toEqual([]);
  });
});

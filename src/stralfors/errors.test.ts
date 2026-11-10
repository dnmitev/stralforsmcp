/*
 * R7 error model. API under test (src/stralfors/errors.ts):
 *   class StralforsError extends Error { kind: string; status?: number; traceId?: string; profile?: string;
 *                                        operation?: string; safeMessage: string }   // message === safeMessage
 *   Subclasses (kind): ConfigError config, TlsError tls, AuthError auth (+detail?: string), ForbiddenError forbidden,
 *     AgreementNotFoundError agreement_not_found (+actionId?), RouteNotFoundError route_not_found,
 *     BadRequestError bad_request (+errors?: Record<string,string[]>), ValidationFailedError validation_failed
 *     (+violations: Violation[], +faults: raw faults[]), ConflictError conflict, RateLimitedError rate_limited
 *     (+retryAfterMs?), UpstreamError upstream, TimeoutError timeout, ResponseTooLargeError too_large,
 *     SchemaError schema (+issues: {path: string}[]), WriteBlockedError write_blocked, TokenFormatError,
 *     RequestValidationError (+fields: string[]).
 *   Violation { ruleId?: string; tag?: string; path: string; criteria: string[]; serverError?: true }
 *   mapHttpError(res: { status: number; contentType?: string; body: string; retryAfter?: string },
 *                ctx: { profile: string; operation: string }): StralforsError     (pure; used by the HTTP core)
 *   safeMessage contains no header values, no body text except faultCode/explanationText/errors keys, no identity ids,
 *   no DtoGuid. JSON.stringify / inspect / toString never carry body text or secrets.
 */
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgreementNotFoundError, BadRequestError, ConflictError, ForbiddenError, RateLimitedError, RouteNotFoundError,
  StralforsError, UpstreamError, ValidationFailedError, mapHttpError,
} from './errors.ts';
import { canary, fixture, memoryLogger, startFakeApi, testClient, type FakeApi } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

let pki: Pki;
let fake: FakeApi | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const ctx = { profile: 'a', operation: 'test' };
const faultBody = JSON.stringify({
  message: 'm',
  compositeFault: { faults: [{ faultCode: null, explanationText: 'm', paramValues: [{ param: '#2:Document.DocumentHeader.TimeStamp', value: 'Required' }] }] },
});

describe('R7 error mapping', () => {
  const rows: [number, string, string, Record<string, string>, new (...a: never[]) => StralforsError, string][] = [
    [400, 'application/problem+json', '{"title":"x","status":400,"errors":{"a":["b"]},"traceId":"t"}', {}, BadRequestError, 'bad_request'],
    [400, 'application/json', faultBody, {}, ValidationFailedError, 'validation_failed'],
    [403, 'application/json', '{"message":"forbidden","compositeFault":null}', {}, ForbiddenError, 'forbidden'],
    [404, 'application/json', `{"message":"CustomerContract was not found ... actionId 'G'.","compositeFault":null}`, {}, AgreementNotFoundError, 'agreement_not_found'],
    [404, 'text/plain; charset=us-ascii', 'No Mapping Rule matched', {}, RouteNotFoundError, 'route_not_found'],
    [409, 'application/json', '{"message":"A consignment already exists.","compositeFault":null}', {}, ConflictError, 'conflict'],
    [429, 'text/plain', 'Too Many Requests', { 'retry-after': '7' }, RateLimitedError, 'rate_limited'],
    [503, 'text/html', '<html>down</html>', {}, UpstreamError, 'upstream'],
  ];
  it.each(rows)('status to class: %s %s', async (status, type, body, headers, Cls, kind) => {
    fake = await startFakeApi({
      pki,
      api: (_q, res) => {
        res.writeHead(status, { 'content-type': type, ...headers });
        res.end(body);
      },
    });
    const { client } = testClient(pki, fake);
    const err = await client.get('/rest/x', { schema: z.unknown() }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Cls);
    expect(err).toBeInstanceOf(StralforsError);
    expect([(err as StralforsError).kind, (err as StralforsError).status]).toEqual([kind, status]);
    if (status === 429) expect((err as RateLimitedError).retryAfterMs).toBe(7000);
    if (status === 404 && kind === 'agreement_not_found') expect((err as AgreementNotFoundError).actionId).toBe('G');
    if (status === 400 && kind === 'bad_request') {
      expect((err as BadRequestError).errors).toEqual({ a: ['b'] });
      expect((err as BadRequestError).traceId).toBe('t');
      expect((err as BadRequestError).message).toBe('bad request: 1 field(s)');
    }
  });

  it('fixtures map to their classes', () => {
    const p = mapHttpError({ status: 400, contentType: 'application/problem+json; charset=utf-8', body: fixture('error-problemdetails.json') }, ctx);
    expect(p).toBeInstanceOf(BadRequestError);
    expect(p.traceId).toBe(JSON.parse(fixture('error-problemdetails.json')).traceId);
    expect(mapHttpError({ status: 404, contentType: 'application/json', body: fixture('error-errorresponse-404.json') }, ctx)).toBeInstanceOf(AgreementNotFoundError);
    expect(mapHttpError({ status: 404, contentType: 'text/plain; charset=us-ascii', body: fixture('gateway-404.txt') }, ctx)).toBeInstanceOf(RouteNotFoundError);
    expect(mapHttpError({ status: 400, contentType: 'application/json', body: fixture('error-errorresponse-400-faults.json') }, ctx)).toBeInstanceOf(ValidationFailedError);
  });

  it('safeMessage never echoes identity', () => {
    const id = canary('CLIENT-ID');
    const guid = randomUUID();
    const body = JSON.stringify({ message: `ValidateInvoice | DtoGuid: ${randomUUID()} | CustomerContract was not found based on identityId '${id}' and ActionId '${guid}'.`, compositeFault: null });
    const e = mapHttpError({ status: 404, contentType: 'application/json', body }, ctx);
    for (const s of [e.safeMessage, e.message, String(e), JSON.stringify(e), inspect(e, { depth: null }), e.stack ?? '']) {
      expect(s).not.toContain(id);
    }
    expect((e as AgreementNotFoundError).actionId).toBe(guid);
  });

  it('fault payloads stay readable by name but are not enumerable', () => {
    const id = canary('IDENT');
    const faults = [{ explanationText: `DtoGuid ${randomUUID()} identityId '${id}'`, paramValues: [] }];
    const e = mapHttpError({ status: 400, contentType: 'application/json', body: JSON.stringify({ compositeFault: { faults } }) }, ctx) as ValidationFailedError;
    expect(e.faults).toEqual(faults);
    for (const s of [JSON.stringify({ ...e }), JSON.stringify(Object.assign({}, e)), Object.keys(e).join()]) expect(s).not.toContain(id);
    expect(Object.keys(e)).not.toContain('faults');
  });

  describe('malformed compositeFault entries never throw', () => {
    const good = { param: '#2:Document.DocumentHeader.TimeStamp', value: 'Required' };
    const bodies: [string, unknown[]][] = [
      ['null fault entry', [null, { paramValues: [good] }]],
      ['paramValues not an array', [{ paramValues: 'oops' }, { paramValues: [good] }]],
      ['paramValues item is null', [{ paramValues: [null, good] }]],
      ['value is null', [{ paramValues: [{ param: '#1:X.Y', value: null }, good] }]],
      ['param is not a string', [{ paramValues: [{ param: 42, value: 'v' }, good] }]],
    ];
    it.each(bodies)('mapHttpError: %s', (_n, faults) => {
      const body = JSON.stringify({ message: 'm', compositeFault: { faults } });
      let e: StralforsError | undefined;
      expect(() => void (e = mapHttpError({ status: 400, contentType: 'application/json', body }, ctx))).not.toThrow();
      expect(e).toBeInstanceOf(ValidationFailedError);
      expect(e!.kind).toBe('validation_failed');
      for (const v of (e as ValidationFailedError).violations) expect([typeof v.path, v.criteria.every((c) => typeof c === 'string')]).toEqual(['string', true]);
      expect((e as ValidationFailedError).violations).toContainEqual({ ruleId: '2', tag: undefined, path: 'Document.DocumentHeader.TimeStamp', criteria: ['Required'] });
    });

    it.each(bodies)('end to end: %s is request.failed with validation_failed', async (_n, faults) => {
      fake = await startFakeApi({
        pki,
        api: (_q, res) => {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'm', compositeFault: { faults } }));
        },
      });
      const mem = memoryLogger();
      const { client } = testClient(pki, fake, { logger: mem.logger });
      const err = await client.get('/rest/x', { schema: z.unknown() }).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationFailedError);
      expect(mem.lines().find((l) => l['msg'] === 'request.failed')).toMatchObject({ kind: 'validation_failed', status: 400 });
    });
  });

  it('traceId is surfaced', () => {
    const body = JSON.stringify({ type: 't', title: 'x', status: 400, errors: { a: ['b'] }, traceId: '00-abc-def-00' });
    const e = mapHttpError({ status: 400, contentType: 'application/problem+json', body }, ctx);
    expect(e.traceId).toBe('00-abc-def-00');
  });

  it('non-JSON bodies are kept out of the message', () => {
    const c = canary('body');
    const e = mapHttpError({ status: 503, contentType: 'text/html', body: `<html>${c}</html>` }, ctx);
    expect(e.message).not.toContain(c);
    expect(JSON.stringify(e)).not.toContain(c);
  });

  it('429 Retry-After as HTTP date or missing', () => {
    const none = mapHttpError({ status: 429, contentType: 'text/plain', body: 'x' }, ctx) as RateLimitedError;
    expect(none.retryAfterMs).toBeUndefined();
    const date = new Date(Date.now() + 30_000).toUTCString();
    const e = mapHttpError({ status: 429, contentType: 'text/plain', body: 'x', retryAfter: date }, ctx) as RateLimitedError;
    expect(e.retryAfterMs).toBeGreaterThan(20_000);
    expect(e.retryAfterMs).toBeLessThanOrEqual(30_000);
  });
});

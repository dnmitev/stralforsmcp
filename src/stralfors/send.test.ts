/*
 * 06-02 Task 1: client sendInvoice (ADR 0028). One POST to the exact send route, never replayed, never retried,
 * detached from the caller's abort once started. Synthetic bodies only.
 */
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withSignal } from './abort.ts';
import { AuthError, CancelledError, ConflictError, RequestValidationError, TimeoutError, UpstreamError, ValidationFailedError, WriteBlockedError } from './errors.ts';
import { json, startFakeApi, testClient, type FakeApi } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

let pki: Pki;
let fake: FakeApi | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const SEND = '/rest/outputmanagement/apiomni/v2/invoices/true';
const WRITE = { extra: { STRALFORS_ALLOW_WRITE: 'true' } };
const body = () => ({ actionId: randomUUID(), consignmentId: 'SEND-TEST-0001', document: { documentHeader: { channelPriority: ['X'] }, invoice: { id: 'INV-1' } } });
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const sends = (f: FakeApi) => f.apiRequests.filter((r) => r.url === SEND);
const serve = (reply: (req: IncomingMessage, res: Parameters<typeof json>[0]) => void) => startFakeApi({ pki, api: (req, res) => (req.url === SEND ? reply(req, res) : json(res, 404, 'No Mapping Rule matched', 'text/plain')) });

describe('sendInvoice: the request', () => {
  it('one POST to the exact send route, no query, body passed unchanged (consignmentId included)', async () => {
    fake = await serve((_q, res) => json(res, 201, ''));
    const { client } = testClient(pki, fake, WRITE);
    const b = body();
    await expect(client.sendInvoice(b)).resolves.toEqual({ ok: true });
    expect(sends(fake)).toHaveLength(1);
    expect(sends(fake)[0]!.method).toBe('POST');
    expect(JSON.parse(sends(fake)[0]!.body)).toEqual(b);
  });
  it('a 2xx whose body is not JSON still counts as sent (the vendor accepted it)', async () => {
    fake = await serve((_q, res) => json(res, 201, 'Created', 'text/plain'));
    const { client } = testClient(pki, fake, WRITE);
    await expect(client.sendInvoice(body())).resolves.toEqual({ ok: true });
  });
  it('the request shape is checked before any I/O: actionId uuid, consignmentId 10..50', async () => {
    fake = await serve((_q, res) => json(res, 201, ''));
    const { client } = testClient(pki, fake, WRITE);
    for (const bad of [{ ...body(), actionId: 'nope' }, { ...body(), consignmentId: 'short' }, { ...body(), consignmentId: 'x'.repeat(51) }])
      expect(await rejection(client.sendInvoice(bad))).toBeInstanceOf(RequestValidationError);
    expect(fake.apiRequests).toHaveLength(0);
    expect(fake.tokenRequests).toHaveLength(0);
  });
  it('a malformed 200 from the token endpoint fails the call: the invoice was never posted, so it is not "sent"', async () => {
    fake = await startFakeApi({ pki, token: (_q, res) => json(res, 200, { token_type: 'Bearer' }), api: (_q, res) => json(res, 201, '') });
    const { client } = testClient(pki, fake, WRITE);
    expect(await rejection(client.sendInvoice(body()))).toMatchObject({ kind: 'schema', operation: 'token' });
    expect(sends(fake)).toHaveLength(0);
  });
  it('without STRALFORS_ALLOW_WRITE the write guard blocks it: no token fetch, no socket', async () => {
    fake = await serve((_q, res) => json(res, 201, ''));
    const { client } = testClient(pki, fake);
    expect(await rejection(client.sendInvoice(body()))).toBeInstanceOf(WriteBlockedError);
    expect(fake.apiRequests).toHaveLength(0);
    expect(fake.tokenRequests).toHaveLength(0);
  });
});

describe('sendInvoice: never replayed, never retried', () => {
  it('401: the token is invalidated but the POST is not sent again', async () => {
    fake = await serve((_q, res) => json(res, 401, {}));
    const { client } = testClient(pki, fake, WRITE);
    expect(await rejection(client.sendInvoice(body()))).toBeInstanceOf(AuthError);
    expect(sends(fake)).toHaveLength(1);
  });
  it.each([
    ['5xx', (res: Parameters<typeof json>[0]) => json(res, 503, {}), UpstreamError],
    ['400 faults', (res: Parameters<typeof json>[0]) => json(res, 400, { compositeFault: { faults: [{ paramValues: [{ param: '#1:Document.Invoice.Id', value: 'Required' }] }] } }), ValidationFailedError],
    ['409', (res: Parameters<typeof json>[0]) => json(res, 409, {}), ConflictError],
  ])('%s: one request, typed error, no retry', async (_n, reply, Err) => {
    fake = await serve((_q, res) => reply(res));
    const { client } = testClient(pki, fake, WRITE);
    expect(await rejection(client.sendInvoice(body()))).toBeInstanceOf(Err);
    expect(sends(fake)).toHaveLength(1);
  });
  it('timeout: TimeoutError after one request, no retry', async () => {
    fake = await serve(() => undefined); // never answers
    const { client } = testClient(pki, fake, { extra: { STRALFORS_ALLOW_WRITE: 'true', STRALFORS_TIMEOUT_MS: '200' } });
    expect(await rejection(client.sendInvoice(body()))).toBeInstanceOf(TimeoutError);
    expect(sends(fake)).toHaveLength(1);
  });
});

describe('sendInvoice: detached once started (ADR 0028 item 5)', () => {
  it('a caller abort after the POST started does not abort it: the send completes', async () => {
    let finish: (() => void) | undefined;
    fake = await serve((_q, res) => void (finish = () => json(res, 201, '')));
    const { client } = testClient(pki, fake, WRITE);
    const ac = new AbortController();
    const p = withSignal(ac.signal, () => client.sendInvoice(body()));
    await expect.poll(() => sends(fake!).length).toBe(1);
    ac.abort();
    finish!();
    await expect(p).resolves.toEqual({ ok: true });
  });
  it('an already aborted caller sends nothing', async () => {
    fake = await serve((_q, res) => json(res, 201, ''));
    const { client } = testClient(pki, fake, WRITE);
    const ac = new AbortController();
    ac.abort();
    expect(await rejection(withSignal(ac.signal, () => client.sendInvoice(body())))).toBeInstanceOf(CancelledError);
    expect(fake.apiRequests).toHaveLength(0);
    expect(fake.tokenRequests).toHaveLength(0);
  });
});

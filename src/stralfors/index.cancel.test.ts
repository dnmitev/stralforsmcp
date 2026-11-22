// R-11: the caller's abort signal (withSignal) reaches the upstream request; token fetches and timeouts are unaffected.
import type { IncomingMessage } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withSignal } from './abort.ts';
import { CancelledError, TimeoutError } from './errors.ts';
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
const any = { schema: z.unknown() };
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe('caller abort', () => {
  it('aborts the in-flight request: CancelledError, the upstream socket closes, no replay', async () => {
    let closed = 0;
    fake = await startFakeApi({ pki, api: (req: IncomingMessage, res) => (req.url === '/rest/hang' ? void res.on('close', () => closed++) : json(res, 200, {})) });
    const { client } = testClient(pki, fake);
    const ac = new AbortController();
    const started = Date.now();
    const p = withSignal(ac.signal, () => client.get('/rest/hang', any));
    setTimeout(() => ac.abort(), 100);
    const err = await rejection(p);
    expect(err).toBeInstanceOf(CancelledError);
    expect((err as CancelledError).kind).toBe('cancelled');
    expect((err as CancelledError).message).toBe('request cancelled by the caller');
    expect(Date.now() - started).toBeLessThan(2000);
    await expect.poll(() => closed).toBe(1);
    expect(fake.apiRequests.filter((r) => r.url === '/rest/hang')).toHaveLength(1);
  });
  it('an already aborted signal fails before any token fetch or socket', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 200, {}) });
    const { client } = testClient(pki, fake);
    const ac = new AbortController();
    ac.abort();
    expect(await rejection(withSignal(ac.signal, () => client.get('/rest/ping', any)))).toBeInstanceOf(CancelledError);
    expect(fake.tokenRequests).toHaveLength(0);
    expect(fake.apiRequests).toHaveLength(0);
  });
  it('a live signal changes nothing: answers pass, the own timeout is still TimeoutError', async () => {
    fake = await startFakeApi({ pki, api: (req, res) => (req.url === '/rest/hang' ? undefined : json(res, 200, { ok: 1 })) });
    const { client } = testClient(pki, fake, { extra: { STRALFORS_TIMEOUT_MS: '200' } });
    const ac = new AbortController();
    await expect(withSignal(ac.signal, () => client.get('/rest/ping', any))).resolves.toEqual({ ok: 1 });
    expect(await rejection(withSignal(ac.signal, () => client.get('/rest/hang', any)))).toBeInstanceOf(TimeoutError);
  });
  it('outside any scope requests run as before', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 200, { ok: 2 }) });
    const { client } = testClient(pki, fake);
    await expect(client.get('/rest/ping', any)).resolves.toEqual({ ok: 2 });
  });
});

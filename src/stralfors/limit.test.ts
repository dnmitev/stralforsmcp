// R-11: per-pod cap on concurrent upstream requests, fast refusal, no slot leak on any path.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withSignal } from './abort.ts';
import { BusyError, CancelledError, TimeoutError, UpstreamError } from './errors.ts';
import { createUpstreamLimit } from './limit.ts';
import { json, startFakeApi, testClient, type FakeApi } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

describe('createUpstreamLimit', () => {
  it('takes slots up to max, refuses the next, frees on release, never goes below zero', () => {
    const l = createUpstreamLimit(2);
    expect([l.tryAcquire(), l.tryAcquire(), l.tryAcquire()]).toEqual([true, true, false]);
    expect(l.inFlight).toBe(2);
    l.release();
    expect(l.inFlight).toBe(1);
    expect(l.tryAcquire()).toBe(true);
    l.release(); l.release(); l.release();
    expect(l.inFlight).toBe(0);
    expect(l.tryAcquire()).toBe(true);
  });
});

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

describe('client with a shared limit', () => {
  it('a full cap refuses at once with BusyError: no token fetch, no socket; a freed slot serves again', async () => {
    const held: ServerResponse[] = [];
    fake = await startFakeApi({ pki, api: (req: IncomingMessage, res) => (req.url === '/rest/hold' ? void held.push(res) : json(res, 200, { ok: 1 })) });
    const limit = createUpstreamLimit(1);
    const { client } = testClient(pki, fake, { upstreamLimit: limit } );
    const first = client.get('/rest/hold', any);
    await expect.poll(() => held.length).toBe(1);
    const tokens = fake.tokenRequests.length;
    const err = await rejection(client.get('/rest/ping', any));
    expect(err).toBeInstanceOf(BusyError);
    expect((err as BusyError).kind).toBe('busy');
    expect((err as BusyError).message).toBe('upstream busy, try again shortly');
    expect(fake.tokenRequests).toHaveLength(tokens);
    expect(fake.apiRequests.filter((r) => r.url === '/rest/ping')).toHaveLength(0);
    json(held[0]!, 200, {});
    await first;
    expect(limit.inFlight).toBe(0);
    await expect(client.get('/rest/ping', any)).resolves.toEqual({ ok: 1 });
    expect(limit.inFlight).toBe(0);
  });
  it('releases the slot after an upstream error, a timeout and a cancel', async () => {
    fake = await startFakeApi({ pki, api: (req, res) => (req.url === '/rest/hang' ? undefined : json(res, 503, {})) });
    const limit = createUpstreamLimit(1);
    const { client } = testClient(pki, fake, { upstreamLimit: limit, extra: { STRALFORS_TIMEOUT_MS: '150' } } );
    expect(await rejection(client.get('/rest/boom', any))).toBeInstanceOf(UpstreamError);
    expect(limit.inFlight).toBe(0);
    expect(await rejection(client.get('/rest/hang', any))).toBeInstanceOf(TimeoutError);
    expect(limit.inFlight).toBe(0);
    const ac = new AbortController();
    const p = rejection(withSignal(ac.signal, () => client.get('/rest/hang', any)));
    setTimeout(() => ac.abort(), 30);
    expect(await p).toBeInstanceOf(CancelledError);
    expect(limit.inFlight).toBe(0);
  });
  it('a refused or pre-cancelled request takes no slot', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 200, {}) });
    const limit = createUpstreamLimit(1);
    const { client } = testClient(pki, fake, { upstreamLimit: limit } );
    const ac = new AbortController();
    ac.abort();
    expect(await rejection(withSignal(ac.signal, () => client.get('/rest/x', any)))).toBeInstanceOf(CancelledError);
    expect(limit.inFlight).toBe(0);
  });
});

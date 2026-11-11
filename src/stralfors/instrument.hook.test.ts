/*
 * R32 client hook (no OTel involved). API under test: createClient({ instrument? }) (src/stralfors/index.ts).
 * instrument wraps one upstream request: { operation: opts.operation ?? 'raw', method }; default is identity; the client packages import no OTel.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, loadConfig, StralforsError, WriteBlockedError, type CreateClientOptions } from './index.ts';
import { json, makeEnv } from '../../test/helpers/api.ts';
import { CHANNELS_PATH, startChannelsApi } from '../../test/helpers/boot.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

let pki: Pki;
let api: Awaited<ReturnType<typeof startChannelsApi>> | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await api?.fake.close();
  api = undefined;
});

async function setup(instrument?: CreateClientOptions['instrument'], extra: Record<string, string | undefined> = {}) {
  api = await startChannelsApi(pki);
  const config = loadConfig(makeEnv(pki, { extra }).env);
  const client = createClient({ config, profileId: 'a', ca: pki.ca, baseUrl: api.fake.url, ...(instrument ? { instrument } : {}) });
  return { client, ...api };
}
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const SRC = new URL('..', import.meta.url);

describe('no OTel in the client packages', () => {
  it.each(['stralfors', 'audit', 'auth', 'policy'])('src/%s imports no @opentelemetry package', (dir) => {
    for (const f of readdirSync(new URL(`${dir}/`, SRC)).filter((n) => n.endsWith('.ts') && !n.includes('.test.'))) {
      expect(readFileSync(new URL(`${dir}/${f}`, SRC), 'utf8'), `${dir}/${f}`).not.toContain('@opentelemetry');
    }
  });

  it('no propagation.inject / extract anywhere in src', () => {
    const walk = (u: URL): string[] => readdirSync(u, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, u)) : e.name.endsWith('.ts') && !e.name.includes('.test.') ? [new URL(e.name, u).pathname] : []));
    for (const f of walk(SRC)) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/propagation\.(inject|extract)|recordException|addEvent\(/);
    }
  });
});

describe('createClient instrument hook', () => {
  it('default: behaves as before', async () => {
    const w = await setup();
    await expect(w.client.channels()).resolves.toEqual(expect.any(Array));
    expect(w.channelRequests()).toHaveLength(1);
  });

  it('wraps each request once with operation and method only; a bare call is "raw"', async () => {
    const spy = vi.fn(<T>(_i: { operation: string; method: string }, run: () => Promise<T>) => run());
    const w = await setup(spy);
    await w.client.channels();
    await w.client.get(CHANNELS_PATH);
    expect(spy.mock.calls.map(([i]) => i)).toEqual([{ operation: 'channels', method: 'GET' }, { operation: 'raw', method: 'GET' }]);
    expect(w.channelRequests()).toHaveLength(2);
    expect(w.fake.tokenRequests).toHaveLength(1);
  });

  it('the info never carries a path, query or id', async () => {
    const seen: unknown[] = [];
    const w = await setup((i, run) => (seen.push(i), run()));
    await w.client.get(`${CHANNELS_PATH}?actionId=abc`);
    expect(JSON.stringify(seen)).not.toMatch(/rest|actionId|abc|invoices/);
  });

  it('the token fetch and the HTTP request happen inside run(): a hook that never runs it sends nothing', async () => {
    const w = await setup(async () => { throw new Error('hook says no'); });
    await expect(w.client.channels()).rejects.toThrow('hook says no');
    expect(w.fake.requests).toHaveLength(0);
  });

  it('the hook sees the thrown StralforsError and the caller gets the same object', async () => {
    let inHook: unknown;
    const w = await setup(async (_i, run) => { try { return await run(); } catch (e) { inHook = e; throw e; } });
    w.reply.current = (_q, res) => json(res, 404, { message: "action id 'x' not found" });
    const e = await rejection(w.client.channels());
    expect(e).toBeInstanceOf(StralforsError);
    expect(e).toBe(inHook);
    expect((e as StralforsError).kind).toBe('agreement_not_found');
  });

  it('write guard and path checks refuse before the hook', async () => {
    const spy = vi.fn(<T>(_i: unknown, run: () => Promise<T>) => run());
    const w = await setup(spy, { STRALFORS_ENV: 'prod' });
    expect(await rejection(w.client.put(CHANNELS_PATH, {}))).toBeInstanceOf(WriteBlockedError);
    expect(await rejection(w.client.get('/not-allowed'))).toMatchObject({ message: 'path not allowed' });
    expect(spy).not.toHaveBeenCalled();
  });
});


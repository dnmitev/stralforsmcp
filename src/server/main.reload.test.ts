/*
 * 02-06 AC-4 through start(): every profile's client polls its cert files every STRALFORS_CERT_RELOAD_S seconds (default 60),
 * start() passes no extra option for it (the config carries the interval), and close() clears each timer before it closes the agent.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../stralfors/errors.ts';
import { createAgent, createClient, type CreateClientOptions } from '../stralfors/index.ts';
import { start, type Started } from './main.ts';
import { sink } from '../../test/helpers/server.ts';
import { fixture, T } from '../../test/helpers/token-list.ts';
import { makeEnv } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

let pki: Pki;
let base: Record<string, string>;
beforeAll(() => {
  pki = generatePki();
  base = { MCP_TOKEN_LIST_FILE: 'x', MCP_HOSTNAMES: '127.0.0.1', MCP_PORT: '0', MCP_METRICS_PORT: '0', MCP_METRICS_HOST: '127.0.0.1', MCP_LISTEN_HOST: '127.0.0.1', ...makeEnv(pki).env };
});
afterAll(() => pki.cleanup());
const started: Started[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(started.splice(0).map((s) => s.close()));
});

/** real clients with a manual timer and an agent spy; the order log shows what close() does first */
function rig() {
  const order: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const agents = vi.fn((p: Parameters<typeof createAgent>[0], o?: Parameters<typeof createAgent>[1]) => {
    const a = createAgent(p, o);
    const close = a.close.bind(a) as (cb?: () => void) => Promise<void> | void;
    // undici's promise-form close() re-enters this.close(cb): forward the callback form untouched and log only the outer call
    (a as unknown as { close: (cb?: () => void) => Promise<void> | void }).close = (cb?: () => void) => (cb ? close(cb) : (order.push('agent.close'), close()));
    return a;
  });
  const options: CreateClientOptions[] = [];
  const clientFactory = (o: CreateClientOptions) => {
    options.push(o);
    return createClient({
      ...o, createAgent: agents as typeof createAgent,
      setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
      clearTimer: () => void order.push('timer.clear'),
    });
  };
  return { order, timers, agents, options, clientFactory };
}
const f = fixture();
const go = async (env: Record<string, string | undefined>, clientFactory: (o: CreateClientOptions) => ReturnType<typeof createClient>) => {
  const s = await start({ ...base, ...env }, { readFile: (p) => (p === 'x' ? f.text() : readFileSync(p, 'utf8')), stderr: { write: () => undefined }, audit: sink().audit, now: () => T, onSignal: () => undefined, clientFactory });
  started.push(s);
  return s;
};

describe('cert reload through start()', () => {
  it('each client polls at the default 60 s, with nothing but the config carrying the interval', async () => {
    const r = rig();
    await go({}, r.clientFactory);
    expect(r.timers.map((t) => t.ms)).toEqual([60_000]);
    expect(Object.keys(r.options[0]!).sort()).toEqual(['config', 'instrument', 'logger', 'now', 'onBlocked', 'profileId']);
    expect(r.options[0]!.config.certReloadS).toBe(60);
  });

  it('STRALFORS_CERT_RELOAD_S sets the interval', async () => {
    const r = rig();
    await go({ STRALFORS_CERT_RELOAD_S: '9' }, r.clientFactory);
    expect(r.timers.map((t) => t.ms)).toEqual([9_000]);
  });

  it.each(['0', 'abc', '-3'])('STRALFORS_CERT_RELOAD_S=%s refuses to start', async (v) => {
    const r = rig();
    await expect(start({ ...base, STRALFORS_CERT_RELOAD_S: v }, { readFile: (p) => (p === 'x' ? f.text() : readFileSync(p, 'utf8')), audit: sink().audit, now: () => T, onSignal: () => undefined, clientFactory: r.clientFactory })).rejects.toThrow(ConfigError);
    expect(r.timers).toEqual([]);
  });

  it('close() clears each timer before closing its agent; a late tick creates no agent', async () => {
    const r = rig();
    const s = await go({}, r.clientFactory);
    expect(r.agents).toHaveBeenCalledTimes(1);
    await s.close();
    expect(r.order).toEqual(['timer.clear', 'agent.close']);
    writeFileSync(base['STRALFORS_PROFILE_A_CERT_FILE']!, pki.foreignClient.cert);
    r.timers[0]!.fn();
    expect(r.agents).toHaveBeenCalledTimes(1);
  });

  it('a tick before close() with changed files swaps the agent through the wired client', async () => {
    const r = rig();
    const s = await go({}, r.clientFactory);
    const e = makeEnv(pki, { who: 'foreign' });
    writeFileSync(base['STRALFORS_PROFILE_A_CERT_FILE']!, readFileSync(e.env['STRALFORS_PROFILE_A_CERT_FILE']!));
    writeFileSync(base['STRALFORS_PROFILE_A_KEY_FILE']!, readFileSync(e.env['STRALFORS_PROFILE_A_KEY_FILE']!));
    r.timers[0]!.fn();
    expect(r.agents).toHaveBeenCalledTimes(2);
    await s.close();
  });
});

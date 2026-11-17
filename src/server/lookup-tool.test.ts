import { describe, expect, it } from 'vitest';
import { AgreementNotFoundError, StralforsError, UpstreamError } from '../stralfors/errors.ts';
import { ERAS, connect, handlerFetch, principal, sink, toAuth } from '../../test/helpers/server.ts';
import { dump, memTelemetry } from '../../test/helpers/telemetry.ts';
import { buildMcp } from './mcp.ts';
import { callTool, ToolInputError } from './tools.ts';
import { createChannelLookup, STILL_RUNNING } from './lookup-tool.ts';
import { whoami } from './whoami.ts';

const CAND = ['CANARY-cand-1', 'CANARY-cand-2', 'CANARY-cand-3'];
const CORR = 'CANARY-corr-0001';
const notReady = () => new AgreementNotFoundError('agreement not found', { status: 404, operation: 'channelLookupResult' });

interface Script { started?: () => unknown; results: (() => unknown)[] }
function fakeClient(s: Script) {
  const calls: { started: unknown[]; polled: string[] } = { started: [], polled: [] };
  let i = 0;
  return {
    calls,
    client: {
      channelLookup: async (b: unknown) => { calls.started.push(b); return (s.started?.() ?? { correlationId: CORR }) as { correlationId: string }; },
      channelLookupResult: async (id: string) => { calls.polled.push(id); const step = s.results[Math.min(i++, s.results.length - 1)]!; const v = step(); if (v instanceof Error) throw v; return v as never; },
    } as never,
  };
}
const answer = (matched: string[], error = '') => () => ({ customerId: 'CANARY-org', results: [{ channel: 'Kivra', matchedCandidates: matched, error }] });
const clock = () => { let t = 1_000_000; const sleeps: number[] = []; return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, advance: (ms: number) => { t += ms; }, sleeps }; };
const deps = (f: ReturnType<typeof fakeClient>, c = clock()) => ({ clients: new Map([['p', f.client]]), now: c.now, sleep: c.sleep });
const ctx = {} as never;
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe('tool definition', () => {
  const t = createChannelLookup({ clients: new Map() });
  it('is named channel_lookup, access lookup, no scope, not read-only but not destructive', () => {
    expect(t.spec).toEqual({ name: 'channel_lookup', access: 'lookup' });
    expect(t.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(t.description).toMatch(/TEST/);
    expect(t.description).toMatch(/not stored|never stored|does not store/i);
  });
  it('input bounds', () => {
    const ok = (a: Record<string, unknown>) => t.inputSchema.safeParse(a).success;
    const c = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);
    expect(ok({ channels: ['Kivra'], candidates: ['a'] })).toBe(true);
    expect(ok({ channels: ['a', 'b', 'c', 'd'], candidates: c(1000) })).toBe(true);
    expect(ok({ channels: [], candidates: ['a'] })).toBe(false);
    expect(ok({ channels: ['a', 'b', 'c', 'd', 'e'], candidates: ['a'] })).toBe(false);
    expect(ok({ channels: ['Kivra'], candidates: [] })).toBe(false);
    expect(ok({ channels: ['Kivra'], candidates: c(1001) })).toBe(false);
    expect(ok({ channels: ['Kiv ra'], candidates: ['a'] })).toBe(false);
    expect(ok({ channels: ['K/x'], candidates: ['a'] })).toBe(false);
    expect(ok({ channels: ['x'.repeat(41)], candidates: ['a'] })).toBe(false);
    expect(ok({ channels: ['x'.repeat(40)], candidates: ['a'] })).toBe(true);
    expect(ok({ channels: ['K'], candidates: [''] })).toBe(false);
    expect(ok({ channels: ['K'], candidates: ['x'.repeat(41)] })).toBe(false);
    expect(ok({ channels: ['K'], candidates: ['x'.repeat(40)] })).toBe(true);
    expect(ok({ channels: ['K'], candidates: ['a'], profile: '' })).toBe(false);
  });
});

describe('run', () => {
  it('starts one lookup, reads the result and maps it by candidate position', async () => {
    const f = fakeClient({ results: [answer([CAND[2]!, CAND[0]!])] });
    const out = await createChannelLookup(deps(f)).run({ channels: ['Kivra'], candidates: CAND }, ctx);
    expect(out).toMatchObject({ profile: 'p', results: [{ channel: 'Kivra', available: [true, false, true] }], unrecognised: 0 });
    expect(f.calls.started).toEqual([{ channels: ['Kivra'], candidates: CAND }]);
    expect(f.calls.polled).toEqual([CORR]);
    expect(new Date(out.checkedAt).toISOString()).toBe(out.checkedAt);
  });
  it('polls every second while the lookup is not completed, then returns', async () => {
    const f = fakeClient({ results: [notReady, notReady, answer([CAND[1]!])] });
    const c = clock();
    const t0 = c.now();
    const out = await createChannelLookup(deps(f, c)).run({ channels: ['Kivra'], candidates: CAND }, ctx);
    expect(out.results).toEqual([{ channel: 'Kivra', available: [false, true, false] }]);
    expect(f.calls.polled).toHaveLength(3);
    expect(c.now() - t0).toBe(2000);
    expect(f.calls.started).toHaveLength(1); // never a second POST
  });
  it('gives up after 20 s with the fixed text and no id', async () => {
    const f = fakeClient({ results: [notReady] });
    const c = clock();
    const e = await rejection(createChannelLookup(deps(f, c)).run({ channels: ['Kivra'], candidates: CAND }, ctx));
    expect(e).toBeInstanceOf(ToolInputError);
    expect((e as Error).message).toBe(STILL_RUNNING);
    expect(STILL_RUNNING).toBe('lookup still running; try again');
    expect(String(e) + JSON.stringify(e)).not.toContain(CORR);
    expect(f.calls.polled.length).toBe(20);
    expect(c.sleeps.every((ms) => ms === 1000)).toBe(true);
    expect(f.calls.started).toHaveLength(1);
  });
  it('the 20 s budget includes the POST: a slow POST leaves less time, and a spent budget polls nothing', async () => {
    const c = clock();
    const slow = fakeClient({ results: [notReady] });
    const base = (slow.client as { channelLookup: (b: unknown) => Promise<unknown> }).channelLookup;
    (slow.client as { channelLookup: (b: unknown) => Promise<unknown> }).channelLookup = async (b) => { const r = await base(b); c.advance(19_500); return r; };
    const e1 = await rejection(createChannelLookup(deps(slow, c)).run({ channels: ['K'], candidates: CAND }, ctx));
    expect((e1 as Error).message).toBe(STILL_RUNNING);
    expect(slow.calls.polled).toHaveLength(1);
    expect(c.sleeps).toEqual([500]); // never sleeps past the budget

    const c2 = clock();
    const spent = fakeClient({ results: [answer([])] });
    const base2 = (spent.client as { channelLookup: (b: unknown) => Promise<unknown> }).channelLookup;
    (spent.client as { channelLookup: (b: unknown) => Promise<unknown> }).channelLookup = async (b) => { const r = await base2(b); c2.advance(20_000); return r; };
    expect(((await rejection(createChannelLookup(deps(spent, c2)).run({ channels: ['K'], candidates: CAND }, ctx))) as Error).message).toBe(STILL_RUNNING);
    expect(spent.calls.polled).toHaveLength(0);
  });
  it('any other poll error ends the call unchanged and does not retry', async () => {
    const boom = new UpstreamError('upstream', { status: 500, operation: 'channelLookupResult' });
    const f = fakeClient({ results: [notReady, () => boom, answer([])] });
    const e = await rejection(createChannelLookup(deps(f)).run({ channels: ['Kivra'], candidates: CAND }, ctx));
    expect(e).toBe(boom);
    expect(e).toBeInstanceOf(StralforsError);
    expect(f.calls.polled).toHaveLength(2);
  });
  it('a start failure propagates and nothing is polled', async () => {
    const boom = new UpstreamError('upstream', { status: 500, operation: 'channelLookup' });
    const f = fakeClient({ started: () => { throw boom; }, results: [answer([])] });
    expect(await rejection(createChannelLookup(deps(f)).run({ channels: ['K'], candidates: CAND }, ctx))).toBe(boom);
    expect(f.calls.polled).toEqual([]);
  });
  it('a failed channel and an unrecognised match are reported without values', async () => {
    const f = fakeClient({ results: [() => ({ results: [{ channel: 'Kivra', matchedCandidates: ['CANARY-other'], error: '' }, { channel: 'Billo', matchedCandidates: [], error: 'CANARY-err' }] })] });
    const out = await createChannelLookup(deps(f)).run({ channels: ['Kivra', 'Billo'], candidates: CAND }, ctx);
    expect(out.results).toEqual([{ channel: 'Kivra', available: [false, false, false] }, { channel: 'Billo', failed: true, reason: 'error' }]);
    expect(out.unrecognised).toBe(1);
    expect(JSON.stringify(out)).not.toMatch(/CANARY-(other|err|org|corr)/);
  });
  it('the profile is resolved like the other tools', async () => {
    const f = fakeClient({ results: [answer([])] });
    const t = createChannelLookup({ clients: new Map([['a', f.client], ['b', f.client]]), ...clock() });
    expect(await rejection(t.run({ channels: ['K'], candidates: ['x'] }, ctx))).toBeInstanceOf(ToolInputError);
    expect((await t.run({ channels: ['K'], candidates: ['x'], profile: 'b' }, ctx)).profile).toBe('b');
  });
});

describe.each(ERAS)('through the registry and the SDK (%s)', (era) => {
  async function setup(env: 'test' | 'prod', role: 'dev' | 'qa' | 'pm' = 'qa', script: Script = { results: [answer([CAND[0]!])] }) {
    const f = fakeClient(script);
    const s = sink();
    const m = memTelemetry();
    const tool = createChannelLookup({ clients: new Map([['p', f.client]]), ...clock() });
    const p = principal(role, role === 'dev' ? ['test', 'prod'] : ['test']);
    const h = handlerFetch(buildMcp({ env, allowWrite: false, prodValidateEnabled: false, audit: s.audit, tools: [whoami, tool], telemetry: m.t }), toAuth(p));
    return { f, s, m, c: await connect(era, h.fetch) };
  }
  const call = (c: Awaited<ReturnType<typeof connect>>, args: Record<string, unknown> = { channels: ['Kivra'], candidates: CAND }) => c.callTool({ name: 'channel_lookup', arguments: args });

  it('test env: listed for qa without any write flag, call returns structured content', async () => {
    const { c, f } = await setup('test');
    expect((await c.listTools()).tools.map((t) => t.name)).toContain('channel_lookup');
    const r = await call(c);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ results: [{ channel: 'Kivra', available: [true, false, false] }] });
    expect(f.calls.started).toHaveLength(1);
  });
  it('prod env: not listed for dev, and a direct call never reaches the client', async () => {
    const { c, f, s } = await setup('prod', 'dev');
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain('channel_lookup');
    const bad = await call(c).then((r) => r.isError === true, () => true);
    expect(bad).toBe(true);
    expect(f.calls.started).toHaveLength(0);
    expect(s.lines().every((l) => l.tool !== 'channel_lookup' || l.outcome === 'denied')).toBe(true);
  });
  it('audit, spans, metrics and errors never hold a candidate, a match, the customer id or the correlation id', async () => {
    for (const script of [{ results: [answer([CAND[1]!])] }, { results: [notReady] }, { results: [() => new UpstreamError('upstream', { status: 500, operation: 'x' })] }, { results: [answer([], 'CANARY-err')] }]) {
      const { c, s, m } = await setup('test', 'qa', script);
      const r = await call(c);
      const all = s.text() + dump(m.spans()) + (await m.text()) + JSON.stringify(r);
      for (const v of [...CAND, CORR, 'CANARY-org', 'CANARY-err']) expect(all, v).not.toContain(v);
    }
  });
  it('a lookup that outlives the budget is audited as timeout', async () => {
    const f = fakeClient({ results: [notReady] });
    const s = sink();
    const c = clock();
    const tool = createChannelLookup({ clients: new Map([['p', f.client]]), ...c });
    const r = await callTool(tool as never, { channels: ['K'], candidates: CAND }, principal('qa', ['test']), { env: 'test', allowWrite: false, prodValidateEnabled: false, audit: s.audit });
    expect(r).toMatchObject({ isError: true, content: [{ text: STILL_RUNNING }] });
    expect(s.lines()[0]).toMatchObject({ outcome: 'error', reason: 'timeout' });
  });
  it('schema-invalid input is refused before the client is touched', async () => {
    const { c, f } = await setup('test');
    const bad = await call(c, { channels: ['Kivra'], candidates: [] }).then((r) => r.isError === true, () => true);
    expect(bad).toBe(true);
    expect(f.calls.started).toHaveLength(0);
  });
});

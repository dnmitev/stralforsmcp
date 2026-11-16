// channel_lookup through the real stack (TEST env, write flag off): the POST reaches the container, the result is polled and mapped, nothing identifying surfaces.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dump } from '../helpers/telemetry.ts';
import { integrationEnabled } from './docker.ts';
import { startWiremock, type WiremockStack } from './wiremock.ts';
import { bootWorld, errText, ok, type World } from './world.ts';

const enabled = await integrationEnabled();
const CL = '/rest/outputmanagement/channellookup/v1/lookup';
const FORBIDDEN_IN_SINKS = ['User configuration is missing', 'CANARY-CAND-', 'CANARYCANDREADY2', 'ZZ-OTHER-SPELLING', 'CANARY-ORG-NUMBER', 'CANARY-LOOKUP', '30000000-0000-4000-8000'];

describe.skipIf(!enabled)('channel_lookup through the real stack', () => {
  let wm: WiremockStack;
  let w: World;
  beforeAll(async () => {
    wm = await startWiremock();
    w = await bootWorld(wm);
  });
  afterAll(async () => {
    await w?.close();
    await wm?.stop();
  });
  beforeEach(() => wm.reset());
  const lookups = async () => (await wm.journal()).filter((r) => r.url.startsWith(CL)).map((r) => ({ method: r.method, url: r.url.split('?')[0]!, body: r.body }));
  const sinks = async (result: unknown) => [JSON.stringify(result), w.logs(), w.audit.text(), dump(w.tel.spans()), await w.tel.text()].join('\n');

  it('is listed in the test env without a write flag', async () => {
    expect((await w.client.listTools()).tools.map((t) => t.name)).toContain('channel_lookup');
  });

  it('POSTs the lookup, reads the result and maps it by candidate position; a channel error is reported as failed', async () => {
    const r = await w.call('channel_lookup', { channels: ['Kivra', 'Billo', 'eInvoiceB2C'], candidates: ['CANARY-CAND-READY-1', 'CANARY-CAND-READY-2'] });
    expect(ok(r)).toMatchObject({ profile: 'a', results: [{ channel: 'Kivra', available: [false, true] }, { channel: 'Billo', failed: true, reason: 'error' }, { channel: 'eInvoiceB2C', failed: true, reason: 'not_configured' }], unrecognised: 0 });
    const seen = await lookups();
    expect(seen.map((x) => [x.method, x.url])).toEqual([['GET', `${CL}/30000000-0000-4000-8000-000000000001`], ['POST', CL]]); // newest first
    expect(JSON.parse(seen[1]!.body)).toEqual({ channels: ['Kivra', 'Billo', 'eInvoiceB2C'], candidates: ['CANARY-CAND-READY-1', 'CANARY-CAND-READY-2'] });
    const all = await sinks(r);
    for (const v of FORBIDDEN_IN_SINKS) expect(all, v).not.toContain(v);
  });

  it('counts matches that map to no candidate without showing them', async () => {
    const r = await w.call('channel_lookup', { channels: ['Kivra'], candidates: ['CANARY-CAND-MISMATCH-1'] });
    expect(ok(r)).toMatchObject({ results: [{ channel: 'Kivra', available: [false] }], unrecognised: 1 });
    const all = await sinks(r);
    for (const v of FORBIDDEN_IN_SINKS) expect(all, v).not.toContain(v);
  });

  it('a vendor refusal of the POST is a kind-only tool error and nothing is polled', async () => {
    const r = await w.call('channel_lookup', { channels: ['Kivra'], candidates: ['CANARY-CAND-FORBIDDEN-1'] });
    expect(errText(r)).toBe('tool failed: forbidden');
    expect((await lookups()).map((x) => x.method)).toEqual(['POST']);
    const all = await sinks(r);
    for (const v of FORBIDDEN_IN_SINKS) expect(all, v).not.toContain(v);
  });

  it('a lookup that never completes ends after about 20 s with the fixed text, one POST only', async () => {
    const r = await w.call('channel_lookup', { channels: ['Kivra'], candidates: ['CANARY-CAND-PENDING-1'] });
    expect(errText(r)).toBe('lookup still running; try again');
    const seen = await lookups();
    expect(seen.filter((x) => x.method === 'POST')).toHaveLength(1);
    expect(seen.filter((x) => x.method === 'GET').length).toBeGreaterThanOrEqual(1); // the cadence is covered with an injected clock in lookup-tool.test.ts
    const all = await sinks(r);
    for (const v of FORBIDDEN_IN_SINKS) expect(all, v).not.toContain(v);
  }, 60_000);
});

/*
 * R20 wrapper: error-kind mapping, ToolInputError/bad_input, principal context, blocked-write attribution.
 * API under test (src/server/tools.ts): ToolInputError, KIND_TEXT, callTool; (src/server/context.ts): currentPrincipal.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fromBlocked } from '../audit/index.ts';
import { StralforsError, UpstreamError, createClient } from '../stralfors/index.ts';
import { currentPrincipal } from './context.ts';
import { ERROR_TEXT, KIND_TEXT, ToolInputError, callTool } from './tools.ts';
import { startChannelsApi, twoProfiles, loadConfig } from '../../test/helpers/boot.ts';
import { KINDS } from '../../test/helpers/kinds.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { mkDef, principal, sink } from '../../test/helpers/server.ts';
import { T } from '../../test/helpers/token-list.ts';

const setup = (over: Partial<Parameters<typeof callTool>[3]> = {}) => {
  const s = sink();
  return { s, deps: { env: 'test' as const, allowWrite: false, audit: s.audit, now: () => T, ...over } };
};
const pm = principal('pm', ['test']);
const thrower = (e: unknown) => mkDef('probe', 'read', async () => { throw e; });
const props = { status: 500, traceId: 'trace-1', profile: 'PROFILE-CANARY', operation: 'OP-CANARY', actionId: 'ID-CANARY', violations: [], faults: [], issues: [], fields: [] };

describe('KIND_TEXT', () => {
  it('formats the safe kind', () => {
    expect(KIND_TEXT('timeout')).toBe('tool failed: timeout');
    expect(ERROR_TEXT).toBe('tool failed');
  });
});

describe('every StralforsError kind maps to its reason and text', () => {
  it('the table has all 17 classes', () => expect(KINDS).toHaveLength(17));
  it.each(KINDS.map(([C, k]) => [C.name, C, k] as const))('%s -> %s', async (_n, C, kind) => {
    const { s, deps } = setup();
    const r = await callTool(thrower(new C('MSG-CANARY', props)), {}, pm, deps);
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: `tool failed: ${kind}` }] });
    expect('structuredContent' in r).toBe(false);
    expect(s.lines()).toHaveLength(1);
    expect(s.lines()[0]).toMatchObject({ outcome: 'error', reason: kind, traceId: 'trace-1', tool: 'probe', userId: pm.userId });
    expect(JSON.stringify(r) + s.text()).not.toMatch(/MSG-CANARY|PROFILE-CANARY|OP-CANARY|ID-CANARY|"500"|500/);
  });

  it('the traceId key is absent when the error has none', async () => {
    const { s, deps } = setup();
    await callTool(thrower(new UpstreamError('x')), {}, pm, deps);
    expect('traceId' in s.lines()[0]!).toBe(false);
    expect(s.lines()[0]).toMatchObject({ reason: 'upstream' });
  });
});

describe('ToolInputError', () => {
  it('is returned verbatim, audited error/bad_input with no traceId', async () => {
    const { s, deps } = setup();
    const r = await callTool(thrower(new ToolInputError('profile is required')), {}, pm, deps);
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'profile is required' }] });
    expect(s.lines()).toHaveLength(1);
    expect(s.lines()[0]).toMatchObject({ outcome: 'error', reason: 'bad_input', tool: 'probe' });
    expect('traceId' in s.lines()[0]!).toBe(false);
  });

  it('is an Error named ToolInputError', () => {
    const e = new ToolInputError('m');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ToolInputError');
    expect(e.message).toBe('m');
  });

  it('a subclass is still bad_input; a StralforsError is never bad_input or error', async () => {
    class Sub extends ToolInputError {}
    const a = setup();
    expect((await callTool(thrower(new Sub('fixed')), {}, pm, a.deps)).content).toEqual([{ type: 'text', text: 'fixed' }]);
    expect(a.s.lines()[0]).toMatchObject({ reason: 'bad_input' });
    const b = setup();
    await callTool(thrower(new StralforsError('forbidden', 'x')), {}, pm, b.deps);
    expect(b.s.lines()[0]).toMatchObject({ reason: 'forbidden' });
  });

  it.each([['Error', new Error('UPSTREAM-CANARY')], ['string', 'S-CANARY'], ['undefined', undefined], ['object', { message: 'O-CANARY' }]])('other throw (%s) still maps to error', async (_n, v) => {
    const { s, deps } = setup();
    const r = await callTool(thrower(v), {}, pm, deps);
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'tool failed' }] });
    expect(s.lines()[0]).toMatchObject({ outcome: 'error', reason: 'error' });
    expect(JSON.stringify(r) + s.text()).not.toMatch(/CANARY/);
  });
});

describe('principal context', () => {
  it('run sees the calling principal after an await; nothing leaks outside', async () => {
    const { deps } = setup();
    const def = mkDef('ctx', 'read', async (_a, c) => {
      await Promise.resolve();
      return { v: currentPrincipal() === c.principal && currentPrincipal() === pm ? 1 : 0 };
    });
    const r = await callTool(def, {}, pm, deps);
    expect(r.structuredContent).toEqual({ v: 1 });
    expect(currentPrincipal()).toBeUndefined();
  });

  it('concurrent calls of different principals see their own', async () => {
    const { deps } = setup();
    const other = principal('qa', ['test']);
    const def = mkDef('ctx', 'read', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { v: currentPrincipal()!.role === 'pm' ? 1 : 2 };
    });
    const [a, b] = await Promise.all([callTool(def, {}, pm, deps), callTool(def, {}, other, deps)]);
    expect([a.structuredContent, b.structuredContent]).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('a denied call never runs nor sets a context', async () => {
    const { deps } = setup();
    let seen: unknown = 'unset';
    const def = mkDef('w', 'write', async () => (seen = currentPrincipal(), { v: 1 }));
    await callTool(def, {}, pm, deps);
    expect(seen).toBe('unset');
  });
});

describe('blocked write is attributed [fake-api]', () => {
  let pki: Pki;
  let api: Awaited<ReturnType<typeof startChannelsApi>> | undefined;
  beforeAll(() => void (pki = generatePki()));
  afterAll(() => pki.cleanup());
  afterEach(async () => void (await api?.fake.close()));

  const build = async (s: ReturnType<typeof sink>) => {
    api = await startChannelsApi(pki);
    const config = loadConfig(twoProfiles(pki).env);
    const client = createClient({
      config, profileId: 'a', ca: pki.ca, baseUrl: api.fake.url,
      onBlocked: (e) => s.audit.record({ ...fromBlocked(e), principal: currentPrincipal(), env: 'test' }),
    });
    const write = mkDef('writeTool', 'write', async () => (await client.post('/rest/outputmanagement/apiomni/v2/invoices/true', {}), { v: 1 }));
    return { client, write };
  };

  it('two audit lines in order, both with the real caller, no upstream request', async () => {
    const { s, deps } = setup({ allowWrite: true, claims: { hasScope: () => true } });
    const { client, write } = await build(s);
    const dev = principal('dev', ['test']);
    const r = await callTool(write, {}, dev, deps);
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'tool failed: write_blocked' }] });
    expect(s.lines().map((l) => ({ outcome: l.outcome, reason: l.reason, userId: l.userId, role: l.role, tool: l.tool }))).toEqual([
      { outcome: 'blocked', reason: 'write_guard', userId: dev.userId, role: 'dev', tool: 'POST /rest/outputmanagement/apiomni/v2/invoices/true' },
      { outcome: 'error', reason: 'write_blocked', userId: dev.userId, role: 'dev', tool: 'writeTool' },
    ]);
    expect(api!.fake.requests).toHaveLength(0);
    await client.close();
  });

  it('outside any call the hook attributes to anonymous', async () => {
    const { s } = setup();
    const { client } = await build(s);
    await expect(client.post('/rest/outputmanagement/apiomni/v2/invoices/true', {})).rejects.toBeInstanceOf(StralforsError);
    expect(s.lines()).toHaveLength(1);
    expect(s.lines()[0]).toMatchObject({ userId: 'anonymous', role: 'anonymous', outcome: 'blocked', reason: 'write_guard' });
    await client.close();
  });
});

/* R13 whoami. API under test (src/server/whoami.ts): whoami, whoamiOutput. */
import { describe, expect, it } from 'vitest';
import { buildMcp } from './mcp.ts';
import { createWhoami, whoami, whoamiOutput } from './whoami.ts';
import { ERAS, connect, handlerFetch, okTool, principal, sink, toAuth, writeTool } from '../../test/helpers/server.ts';
import { callTool } from './tools.ts';
import { generateToken, hashToken } from '../auth/index.ts';

const catalogue = [whoami, okTool, writeTool];
const run = async (era: (typeof ERAS)[number], p: ReturnType<typeof principal>, env: 'test' | 'prod' = 'test', allowWrite = false) => {
  const s = sink();
  const { fetch } = handlerFetch(buildMcp({ env, allowWrite, audit: s.audit, tools: catalogue }), toAuth(p));
  const c = await connect(era, fetch);
  return { c, s, call: () => c.callTool({ name: 'whoami', arguments: {} }) };
};

describe('definition', () => {
  it('metadata', () => {
    expect(whoami.spec).toEqual({ name: 'whoami', access: 'read' });
    expect(whoami.title).toBe('Who am I');
    expect(whoami.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(whoami.description.length).toBeGreaterThan(0);
  });
  it('output schema is strict about shape', () => {
    const ok = { name: 'n', role: 'dev', envs: ['test'], env: 'test', tools: ['whoami'], profiles: [{ id: 'a', country: 'SE' }] };
    expect(whoamiOutput.strict().parse(ok)).toEqual(ok);
    expect(() => whoamiOutput.strict().parse({ ...ok, userId: 'x' })).toThrow();
    expect(() => whoamiOutput.parse({ ...ok, role: 'root' })).toThrow();
    expect(() => whoamiOutput.strict().parse({ ...ok, profiles: [{ id: 'a', country: 'SE', clientId: 'x' }] })).toThrow();
    expect(() => whoamiOutput.parse({ ...ok, profiles: undefined })).toThrow();
  });
  it('envs is a copy', async () => {
    const p = principal('qa', ['test']);
    const ctx = { principal: p, env: 'test' as const, allowWrite: false, visible: [whoami.spec] };
    const out = await whoami.run({}, ctx);
    out.envs.push('prod');
    expect(p.envs).toEqual(['test']);
    expect(out.envs).not.toBe(p.envs);
  });
  it('direct callTool with a principal outside the env is denied', async () => {
    const s = sink();
    const r = await callTool(whoami, {}, principal('pm', ['prod']), { env: 'test', allowWrite: false, audit: s.audit });
    expect(r).toMatchObject({ isError: true, content: [{ text: 'not allowed: env' }] });
  });
});

describe.each(ERAS)('whoami over the SDK (%s era)', (era) => {
  it('structured output matches the schema, text is the JSON of it', async () => {
    const { call } = await run(era, principal('qa', ['test'], 'Q NAME'));
    const r = await call();
    expect(r.structuredContent).toEqual({ name: 'Q NAME', role: 'qa', envs: ['test'], env: 'test', tools: ['whoami', 'okTool'], profiles: [] });
    expect(whoamiOutput.strict().parse(r.structuredContent)).toBeTruthy();
    expect((r.content as { text: string }[])[0]!.text).toBe(JSON.stringify(r.structuredContent));
    expect(r.isError).toBeUndefined();
  });

  it('tools follows visibility in catalogue order (write hidden by the prod constant)', async () => {
    const { call } = await run(era, principal('dev', ['test', 'prod']), 'prod');
    expect((await call()).structuredContent).toMatchObject({ env: 'prod', tools: ['whoami', 'okTool'] });
  });

  it('never leaks token, digest, scope or identifiers', async () => {
    const raw = generateToken();
    const p = principal('dev', ['test']);
    const s = sink();
    const { fetch } = handlerFetch(buildMcp({ env: 'test', allowWrite: false, audit: s.audit, tools: catalogue }), { ...toAuth(p), token: '' });
    const c = await connect(era, fetch);
    const r = await c.callTool({ name: 'whoami', arguments: {} });
    const text = JSON.stringify(r);
    for (const canary of [raw, hashToken(raw), 'apiomni', p.userId]) expect(text).not.toContain(canary);
    for (const k of ['userId', 'token', 'scopes', 'expiresAt']) expect(text).not.toContain(`"${k}"`);
  });

  it('records one allowed audit line', async () => {
    const { call, s } = await run(era, principal('qa', ['test']));
    await call();
    expect(s.lines().map((l) => [l.tool, l.outcome])).toEqual([['whoami', 'allowed']]);
  });

  it('a non-empty arguments object is either stripped or rejected, with at most one audit line', async () => {
    const { c, s } = await run(era, principal('qa', ['test']));
    const r = await c.callTool({ name: 'whoami', arguments: { x: 1 } });
    expect(typeof r).toBe('object');
    expect(s.lines().length).toBeLessThanOrEqual(1);
  });
});

describe('profiles (R24)', () => {
  const profiles = [{ id: 'a', country: 'SE' }, { id: 'b', country: 'NO' }];
  it('the default whoami lists no profiles', async () => {
    const ctx = { principal: principal('qa', ['test']), env: 'test' as const, allowWrite: false, visible: [whoami.spec] };
    expect((await whoami.run({}, ctx)).profiles).toEqual([]);
  });

  it('createWhoami(profiles) returns the profiles in order with id and country only; metadata is unchanged', async () => {
    const w = createWhoami(profiles);
    expect(w.spec).toEqual(whoami.spec);
    expect(w.title).toBe(whoami.title);
    const ctx = { principal: principal('qa', ['test']), env: 'test' as const, allowWrite: false, visible: [w.spec] };
    expect((await w.run({}, ctx)).profiles).toEqual(profiles);
  });

  it('profiles is a copy: mutating the result does not change later calls', async () => {
    const w = createWhoami(profiles);
    const ctx = { principal: principal('qa', ['test']), env: 'test' as const, allowWrite: false, visible: [w.spec] };
    const out = await w.run({}, ctx);
    out.profiles.push({ id: 'x', country: 'x' });
    out.profiles[0]!.id = 'changed';
    expect((await w.run({}, ctx)).profiles).toEqual(profiles);
  });

  it.each(ERAS)('over the SDK (%s): structured content carries the profiles and nothing else about them', async (era) => {
    const s = sink();
    const { fetch } = handlerFetch(buildMcp({ env: 'test', allowWrite: false, audit: s.audit, tools: [createWhoami(profiles)] }), toAuth(principal('qa', ['test'])));
    const c = await connect(era, fetch);
    const r = await c.callTool({ name: 'whoami', arguments: {} });
    expect(r.structuredContent).toMatchObject({ profiles });
    expect(whoamiOutput.strict().parse(r.structuredContent)).toBeTruthy();
    expect(JSON.stringify(r)).not.toMatch(/agreements|clientId|cert/);
  });
});

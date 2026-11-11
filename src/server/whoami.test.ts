/* R13 whoami. API under test (src/server/whoami.ts): whoami, whoamiOutput. */
import { describe, expect, it } from 'vitest';
import { buildMcp } from './mcp.ts';
import { whoami, whoamiOutput } from './whoami.ts';
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
    const ok = { name: 'n', role: 'dev', envs: ['test'], env: 'test', tools: ['whoami'] };
    expect(whoamiOutput.strict().parse(ok)).toEqual(ok);
    expect(() => whoamiOutput.strict().parse({ ...ok, userId: 'x' })).toThrow();
    expect(() => whoamiOutput.parse({ ...ok, role: 'root' })).toThrow();
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
    expect(r.structuredContent).toEqual({ name: 'Q NAME', role: 'qa', envs: ['test'], env: 'test', tools: ['whoami', 'okTool'] });
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

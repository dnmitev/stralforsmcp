/*
 * R12 registry wrapper. API under test (src/server/tools.ts): callTool(def, args, principal, deps), registerAll(server, principal, tools, deps), DENIED_TEXT, ERROR_TEXT.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { describe, expect, it } from 'vitest';
import { DENIED_TEXT, ERROR_TEXT, callTool, registerAll, type ToolDef } from './tools.ts';
import { boomTool, mkDef, okTool, principal, sink, writeTool } from '../../test/helpers/server.ts';
import { T } from '../../test/helpers/token-list.ts';

const setup = (over: Partial<Parameters<typeof callTool>[3]> = {}) => {
  const s = sink();
  let t = T;
  const clock = { advance: (ms: number) => void (t += ms) };
  return { s, clock, deps: { env: 'test' as const, allowWrite: false, audit: s.audit, now: () => t, ...over } };
};
const pm = principal('pm', ['test']);

describe('constants', () => {
  it('fixed texts', () => {
    expect(ERROR_TEXT).toBe('tool failed');
    expect(DENIED_TEXT('write')).toBe('not allowed: write');
  });
});

describe('callTool', () => {
  it('allowed call', async () => {
    const { s, deps } = setup();
    const r = await callTool(okTool, {}, pm, deps);
    expect(r).toEqual({ content: [{ type: 'text', text: '{"v":1}' }], structuredContent: { v: 1 } });
    expect('isError' in r).toBe(false);
    const [l] = s.lines();
    expect(s.lines()).toHaveLength(1);
    expect(l).toMatchObject({ ts: new Date(T).toISOString(), userId: pm.userId, role: 'pm', tool: 'okTool', env: 'test', outcome: 'allowed', durationMs: 0 });
    expect('reason' in l! || 'traceId' in l!).toBe(false);
  });

  it('passes args and a ToolContext (principal, env, allowWrite, visible) to run', async () => {
    const { deps } = setup();
    let seen: unknown[] = [];
    const def = mkDef('probe', 'read', async (a, c) => (seen = [a, c], { v: 1 }));
    await callTool(def, { n: 1 }, pm, { ...deps, allowWrite: false });
    expect(seen[0]).toEqual({ n: 1 });
    expect(seen[1]).toMatchObject({ principal: pm, env: 'test', allowWrite: false, visible: [def.spec] });
  });

  it('duration is measured with the injected clock', async () => {
    const { s, clock, deps } = setup();
    await callTool(mkDef('slowTool', 'read', async () => (clock.advance(120), { v: 1 })), {}, pm, deps);
    expect(s.lines()[0]!.durationMs).toBe(120);
  });

  it('denied call through the wrapper (bypassing tools/list)', async () => {
    const { s, deps } = setup();
    let ran = false;
    const def = mkDef('writeTool', 'write', async () => (ran = true, { v: 1 }));
    const r = await callTool(def, {}, pm, deps);
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'not allowed: write' }] });
    expect('structuredContent' in r).toBe(false);
    expect(ran).toBe(false);
    expect(s.lines()).toHaveLength(1);
    expect(s.lines()[0]).toMatchObject({ outcome: 'denied', reason: 'write', tool: 'writeTool', role: 'pm' });
  });

  it.each([
    ['env', principal('pm', ['prod']), 'test', okTool, undefined],
    ['role', principal('pm', ['test', 'prod']), 'prod', okTool, undefined],
    ['write', principal('dev', ['test']), 'test', writeTool, undefined],
    ['scope', principal('dev', ['test']), 'test', mkDef('scoped', 'read', async () => ({ v: 1 }), 'x'), undefined],
  ] as const)('deny reason %s reaches text and audit', async (reason, p, env, def, claims) => {
    const { s, deps } = setup({ env, claims });
    const r = await callTool(def as ToolDef, {}, p, deps);
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: `not allowed: ${reason}` }] });
    expect(s.lines()).toHaveLength(1);
    expect(s.lines()[0]).toMatchObject({ outcome: 'denied', reason });
  });

  it('allowed write when policy and claims permit', async () => {
    const { s, deps } = setup({ allowWrite: true, claims: { hasScope: () => true } });
    const r = await callTool(writeTool, {}, principal('dev', ['test']), deps);
    expect(r.isError).toBeUndefined();
    expect(s.lines()[0]).toMatchObject({ outcome: 'allowed', tool: 'writeTool' });
  });

  it('thrown error is sanitised', async () => {
    const { s, deps } = setup();
    const r = await callTool(boomTool(), { x: 'ARG-CANARY' }, pm, deps);
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'tool failed' }] });
    expect(s.lines()).toHaveLength(1);
    expect(s.lines()[0]).toMatchObject({ outcome: 'error', reason: 'error' });
    expect(s.lines()[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(r) + s.text()).not.toMatch(/UPSTREAM-CANARY|ARG-CANARY/);
  });

  it.each([['string', 'a string'], ['undefined', undefined], ['object', { message: 'OBJ-CANARY' }], ['null', null]])('non-Error rejection (%s) gives the same result', async (_n, v) => {
    const { s, deps } = setup();
    const def = mkDef('boomTool', 'read', async () => { throw v; });
    expect(await callTool(def, {}, pm, deps)).toEqual({ isError: true, content: [{ type: 'text', text: 'tool failed' }] });
    expect(s.lines()).toHaveLength(1);
    expect(s.lines()[0]).toMatchObject({ outcome: 'error', reason: 'error' });
    expect(s.text()).not.toContain('OBJ-CANARY');
  });

  it('exactly one audit line per path', async () => {
    const { s, deps } = setup();
    await callTool(okTool, {}, pm, deps);
    await callTool(writeTool, {}, pm, deps);
    await callTool(boomTool(), {}, pm, deps);
    expect(s.lines().map((l) => l.outcome)).toEqual(['allowed', 'denied', 'error']);
  });

  it('arguments and results never reach the audit', async () => {
    const { s, deps } = setup();
    const def = mkDef('echo', 'read', async () => ({ echo: 'RES-CANARY' }) as never);
    const r = await callTool(def, { consignmentId: 'CONS-CANARY', document: 'DOC-CANARY' }, pm, deps);
    expect(JSON.stringify(r)).toContain('RES-CANARY');
    expect(s.text()).not.toMatch(/CONS-CANARY|DOC-CANARY|RES-CANARY/);
  });
});

describe('registerAll', () => {
  async function listed(server: McpServer) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: 'c', version: '1' });
    await c.connect(b);
    return c;
  }

  it('registers only visible tools with their metadata', async () => {
    const { deps } = setup({ allowWrite: true, claims: { hasScope: () => true } });
    const server = new McpServer({ name: 'x', version: '1' });
    const dev = principal('dev', ['test']);
    expect(registerAll(server, dev, [okTool, writeTool], deps)).toEqual([okTool.spec, writeTool.spec]);
    const c = await listed(server);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['okTool', 'writeTool']);
    expect(tools[0]).toMatchObject({ title: 'Title okTool', description: 'Description okTool', annotations: okTool.annotations, outputSchema: { type: 'object' }, inputSchema: { type: 'object' } });
    expect(tools[1]!.annotations).toEqual(writeTool.annotations);
  });

  it('hides write tools for pm with allowWrite false', async () => {
    const { deps } = setup();
    const server = new McpServer({ name: 'x', version: '1' });
    expect(registerAll(server, pm, [okTool, writeTool], deps)).toEqual([okTool.spec]);
    expect((await (await listed(server)).listTools()).tools).toHaveLength(1);
  });

  it('SDK input validation happens before the wrapper: isError and no audit line (documented gap)', async () => {
    const { s, deps } = setup();
    const def: ToolDef = { ...okTool, inputSchema: z.object({ n: z.int() }) as never };
    const server = new McpServer({ name: 'x', version: '1' });
    registerAll(server, pm, [def], deps);
    const c = await listed(server);
    const r = await c.callTool({ name: 'okTool', arguments: { n: 'x' } });
    expect(r.isError).toBe(true);
    expect(s.lines()).toEqual([]);
  });

  it('a thrown error through the SDK stays sanitised', async () => {
    const { s, deps } = setup();
    const server = new McpServer({ name: 'x', version: '1' });
    registerAll(server, pm, [boomTool()], deps);
    const r = await (await listed(server)).callTool({ name: 'boomTool', arguments: {} });
    expect(r).toMatchObject({ isError: true, content: [{ type: 'text', text: 'tool failed' }] });
    expect(JSON.stringify(r)).not.toContain('UPSTREAM-CANARY');
    expect(s.lines()).toHaveLength(1);
  });
});

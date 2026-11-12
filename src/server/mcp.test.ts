/*
 * R11 factory. API under test (src/server/mcp.ts): buildMcp({ env, allowWrite, audit, tools, serverInfo?, now? }) => McpServerFactory.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import type { Env, Role } from '../auth/index.ts';
import { buildMcp } from './mcp.ts';
import { whoami } from './whoami.ts';
import { ERAS, connect, devOnly, handlerFetch, okTool, principal, sink, toAuth, writeTool } from '../../test/helpers/server.ts';

const catalogue = [whoami, devOnly, writeTool];
const names = async (era: (typeof ERAS)[number], fetch: typeof globalThis.fetch) => (await (await connect(era, fetch)).listTools()).tools.map((t) => t.name);

// Independent oracle from the R5 rule table with claims undefined: write and requiredScope tools are always hidden; env membership; prod is dev-only.
const oracle = (role: Role, envs: Env[], env: Env): string[] => (envs.includes(env) && (env !== 'prod' || role === 'dev') ? ['whoami'] : []);

const ROWS = (['dev', 'qa', 'pm'] as const).flatMap((role) =>
  (['test', 'prod'] as const).flatMap((env) =>
    [true, false].flatMap((member) => [true, false].map((aw) => ({ role, env, envs: [member ? env : env === 'test' ? 'prod' : 'test'] as Env[], aw }))),
  ),
);

describe('tools/list matrix (24 rows x 2 eras)', () => {
  it('has 24 rows', () => expect(ROWS).toHaveLength(24));
  describe.each(ERAS)('%s era', (era) => {
    it.each(ROWS)('$role envs=$envs env=$env allowWrite=$aw', async ({ role, env, envs, aw }) => {
      const s = sink();
      const { fetch } = handlerFetch(buildMcp({ env, allowWrite: aw, prodValidateEnabled: false, claims: { hasScope: () => false }, audit: s.audit, tools: catalogue }), toAuth(principal(role, envs)));
      expect(await names(era, fetch)).toEqual(oracle(role, envs, env));
      expect(s.lines()).toEqual([]);
    });
  });

  it('whoami is listed first for every row where something is listed', async () => {
    for (const r of ROWS.filter((x) => oracle(x.role, x.envs, x.env).length > 0)) {
      const { fetch } = handlerFetch(buildMcp({ env: r.env, allowWrite: r.aw, prodValidateEnabled: false, claims: { hasScope: () => false }, audit: sink().audit, tools: catalogue }), toAuth(principal(r.role, r.envs)));
      expect((await names('modern', fetch))[0]).toBe('whoami');
    }
  });

  it('catalogue order is preserved', async () => {
    const { fetch } = handlerFetch(buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, claims: { hasScope: () => false }, audit: sink().audit, tools: [okTool, whoami] }), toAuth(principal('qa', ['test'])));
    expect(await names('modern', fetch)).toEqual(['okTool', 'whoami']);
  });
});

describe.each(ERAS)('unlisted tool (%s era)', (era) => {
  it('is unknown (JSON-RPC error) and never reaches the registry', async () => {
    const s = sink();
    const { fetch } = handlerFetch(buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, claims: { hasScope: () => false }, audit: s.audit, tools: catalogue }), toAuth(principal('pm', ['test'])));
    const c = await connect(era, fetch);
    await expect(c.callTool({ name: 'devOnly', arguments: {} })).rejects.toThrow(/not found/);
    expect(s.lines()).toEqual([]);
  });

  it('outside the deployment env even whoami is unknown, list is empty, nothing audited', async () => {
    const s = sink();
    const { fetch } = handlerFetch(buildMcp({ env: 'prod', allowWrite: false, prodValidateEnabled: false, claims: { hasScope: () => false }, audit: s.audit, tools: catalogue }), toAuth(principal('pm', ['test'])));
    const c = await connect(era, fetch);
    expect((await c.listTools()).tools).toEqual([]);
    await expect(c.callTool({ name: 'whoami', arguments: {} })).rejects.toThrow(/not found/);
    expect(s.lines()).toEqual([]);
  });
});

describe('factory properties', () => {
  it('without a principal registers nothing and audits nothing', async () => {
    const s = sink();
    const { fetch } = handlerFetch(buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, claims: { hasScope: () => false }, audit: s.audit, tools: catalogue }), undefined);
    expect(await names('modern', fetch)).toEqual([]);
    expect(s.lines()).toEqual([]);
  });

  it('with authInfo lacking a principal registers nothing (fail closed)', async () => {
    const { fetch } = handlerFetch(buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, claims: { hasScope: () => false }, audit: sink().audit, tools: catalogue }), { token: '', clientId: 'x', scopes: [] });
    expect(await names('legacy', fetch)).toEqual([]);
  });

  it('builds a new McpServer for every request and is synchronous', async () => {
    const factory = buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, claims: { hasScope: () => false }, audit: sink().audit, tools: catalogue });
    const made: unknown[] = [];
    const spy: typeof factory = (ctx) => {
      const r = factory(ctx);
      expect(r).not.toBeInstanceOf(Promise);
      made.push(r);
      return r;
    };
    const { fetch } = handlerFetch(spy, toAuth(principal('qa', ['test'])));
    const c = await connect('modern', fetch);
    await c.listTools();
    await c.callTool({ name: 'whoami', arguments: {} });
    await c.listTools();
    expect(made.length).toBeGreaterThanOrEqual(3);
    expect(new Set(made).size).toBe(made.length);
    expect(made.every((m) => (m as McpServer).constructor.name === 'McpServer')).toBe(true);
  });

  it('concurrent callers with different principals see their own tools (no shared server)', async () => {
    const factory = buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, claims: { hasScope: () => false }, audit: sink().audit, tools: catalogue });
    const a = handlerFetch(factory, toAuth(principal('qa', ['test'])));
    const b = handlerFetch(factory, toAuth(principal('qa', ['prod'])));
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => names('modern', (i % 2 ? a : b).fetch)));
    results.forEach((r, i) => expect(r).toEqual(i % 2 ? ['whoami'] : []));
  });

  it.each(ERAS)('server identity (%s era)', async (era) => {
    const { fetch } = handlerFetch(buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, claims: { hasScope: () => false }, audit: sink().audit, tools: catalogue }), toAuth(principal('qa', ['test'])));
    const c = await connect(era, fetch);
    const info = { name: 'stralforsmcp', version: pkg.version };
    if (era === 'legacy') expect(c.getServerVersion()).toMatchObject(info);
    else expect((await c.listTools())._meta?.['io.modelcontextprotocol/serverInfo']).toMatchObject(info);
  });

  it('serverInfo can be overridden', async () => {
    const { fetch } = handlerFetch(buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, claims: { hasScope: () => false }, audit: sink().audit, tools: catalogue, serverInfo: { name: 'other', version: '9.9.9' } }), toAuth(principal('qa', ['test'])));
    expect((await connect('legacy', fetch)).getServerVersion()).toMatchObject({ name: 'other', version: '9.9.9' });
  });
});

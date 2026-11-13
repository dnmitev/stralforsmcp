/* get_rules and get_example_invoice through the registry and the SDK: policy matrix, outputSchema, audit canary, error kinds. Stub clients, no network. */
import { describe, expect, it } from 'vitest';
import { BadRequestError, UpstreamError, type StralforsClient } from '../stralfors/index.ts';
import { buildMcp } from './mcp.ts';
import { createRulesCache } from './rules-cache.ts';
import { createGetExampleInvoice, createGetRules, getExampleOutput, getRulesOutput } from './rules-tools.ts';
import { whoami } from './whoami.ts';
import { ERAS, connect, handlerFetch, principal, sink, toAuth } from '../../test/helpers/server.ts';

const CANARY = 'CANARY-CHANNEL';
const stub = (over: Partial<Record<'rules' | 'documentExample', () => Promise<unknown>>> = {}) =>
  ({
    rules: async () => ({ channel: CANARY, rules: [{ id: '7', parameter: 'Document.CanaryField', isRequired: true, ruleCriterias: ['Required', 'ExpectedPattern: ^CANARY-PATTERN$'], exampleValue: 'CANARY-EXAMPLE', dependencies: [] }] }),
    documentExample: async () => ({ actionId: 'AGREEMENT-CANARY', consignmentId: 'CONSIGNMENT-0001', document: {} }),
    ...over,
  }) as unknown as StralforsClient;
const tools = (client = stub()) => {
  const clients = new Map([['a', client]]);
  return [whoami, createGetRules({ clients, cache: createRulesCache({ ttlMs: 60_000 }) }), createGetExampleInvoice({ clients })];
};
const mcp = (env: 'test' | 'prod', p = principal('dev', ['test', 'prod']), t = tools()) => {
  const s = sink();
  return { s, ...handlerFetch(buildMcp({ env, allowWrite: false, prodValidateEnabled: false, audit: s.audit, tools: t }), toAuth(p)) };
};

describe('get_rules / get_example_invoice over the SDK', () => {
  it('are listed exactly when whoami is listed, over role x env x principal envs', async () => {
    let listed = 0;
    let unlisted = 0;
    for (const role of ['dev', 'qa', 'pm'] as const) for (const env of ['test', 'prod'] as const) for (const envs of [['test'], ['prod'], ['test', 'prod']] as const) {
      const { fetch } = mcp(env, principal(role, [...envs]));
      const names = (await (await connect('modern', fetch)).listTools()).tools.map((t) => t.name);
      for (const n of ['get_rules', 'get_example_invoice']) expect(names.includes(n), `${role} ${env} ${envs} ${n}`).toBe(names.includes('whoami'));
      if (names.includes('get_rules')) listed++;
      else unlisted++;
    }
    expect(listed).toBeGreaterThan(0);
    expect(unlisted).toBeGreaterThan(0);
  });

  it('prod with a dev principal: both listed and both succeed', async () => {
    const { fetch, s } = mcp('prod');
    const c = await connect('modern', fetch);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['get_rules', 'get_example_invoice']));
    expect((await c.callTool({ name: 'get_rules', arguments: { channel: CANARY } })).isError).toBeFalsy();
    expect((await c.callTool({ name: 'get_example_invoice', arguments: { channels: [CANARY] } })).isError).toBeFalsy();
    expect(s.lines().map((l) => [l.tool, l.env, l.outcome])).toEqual([['get_rules', 'prod', 'allowed'], ['get_example_invoice', 'prod', 'allowed']]);
  });

  it('a pm without prod access has neither tool in prod and a direct call fails with no audit line', async () => {
    const { fetch, s } = mcp('prod', principal('pm', ['test']));
    const c = await connect('modern', fetch);
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain('get_rules');
    expect(await c.callTool({ name: 'get_rules', arguments: { channel: 'X' } }).then((r) => r.isError === true, () => true)).toBe(true);
    expect(s.lines()).toEqual([]);
  });

  it.each(ERAS)('annotations, outputSchema and structuredContent (%s era); nothing from the call reaches the audit line', async (era) => {
    const { fetch, s } = mcp('test');
    const c = await connect(era, fetch);
    const list = (await c.listTools()).tools.filter((t) => t.name !== 'whoami');
    expect(list.map((t) => t.name)).toEqual(['get_rules', 'get_example_invoice']);
    for (const t of list) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
      expect(t.outputSchema).toBeTruthy();
    }
    const r = await c.callTool({ name: 'get_rules', arguments: { channel: CANARY } });
    expect(getRulesOutput.parse(r.structuredContent).rules[0]).toMatchObject({ id: '7', path: 'document.canaryField', required: true, pattern: '^CANARY-PATTERN$', example: 'CANARY-EXAMPLE' });
    const e = await c.callTool({ name: 'get_example_invoice', arguments: { channels: [CANARY] } });
    expect(getExampleOutput.parse(e.structuredContent).example).toEqual({ consignmentId: 'CONSIGNMENT-0001', document: {} });
    expect(JSON.stringify(e)).not.toContain('AGREEMENT-CANARY');
    expect(s.lines()).toHaveLength(2);
    expect(s.text()).not.toMatch(/CANARY/);
  });

  it('input the schema refuses never reaches the client', async () => {
    let calls = 0;
    const { fetch } = mcp('test', undefined, tools(stub({ rules: async () => (calls++, { channel: 'X', rules: [] }) })));
    const c = await connect('modern', fetch);
    for (const args of [{ channel: '' }, { channel: 'X', limit: 201 }, { channel: 'X', offset: -1 }]) {
      expect(await c.callTool({ name: 'get_rules', arguments: args }).then((r) => r.isError === true, () => true)).toBe(true);
    }
    expect(calls).toBe(0);
  });

  it('client errors surface as kinds only, audited with the kind', async () => {
    const t = tools(stub({ rules: async () => { throw new BadRequestError('UPSTREAM-TEXT', { errors: { channel: ['UPSTREAM-DETAIL'] } }); }, documentExample: async () => { throw new UpstreamError('UPSTREAM-TEXT'); } }));
    const { fetch, s } = mcp('test', undefined, t);
    const c = await connect('modern', fetch);
    const a = await c.callTool({ name: 'get_rules', arguments: { channel: 'X' } });
    const b = await c.callTool({ name: 'get_example_invoice', arguments: { channels: ['X'] } });
    expect([a.isError, JSON.stringify(a.content)]).toEqual([true, JSON.stringify([{ type: 'text', text: 'tool failed: bad_request' }])]);
    expect([b.isError, JSON.stringify(b.content)]).toEqual([true, JSON.stringify([{ type: 'text', text: 'tool failed: upstream' }])]);
    expect(s.lines().map((l) => [l.tool, l.outcome, l.reason])).toEqual([['get_rules', 'error', 'bad_request'], ['get_example_invoice', 'error', 'upstream']]);
    expect(s.text()).not.toContain('UPSTREAM');
  });

  it('an unknown profile is bad_input', async () => {
    const { fetch, s } = mcp('test');
    const r = await (await connect('modern', fetch)).callTool({ name: 'get_rules', arguments: { channel: 'X', profile: 'nope' } });
    expect([r.isError, JSON.stringify(r.content)]).toEqual([true, JSON.stringify([{ type: 'text', text: 'unknown profile' }])]);
    expect(s.lines().map((l) => l.reason)).toEqual(['bad_input']);
  });
});

/* get_rules against the in-process mTLS fake (synthetic rule trees, every criterion kind in the documented grammar). */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRulesCache } from './rules-cache.ts';
import { createGetRules, getRulesOutput, type RulesToolDeps } from './rules-tools.ts';
import { ToolInputError, type ToolContext } from './tools.ts';
import { json } from '../../test/helpers/api.ts';
import { INVOICES, loadConfig, realClients, startRoutesApi, twoProfiles } from '../../test/helpers/boot.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { principal } from '../../test/helpers/server.ts';

const RULES = `${INVOICES}/rules`;
let pki: Pki;
let api: Awaited<ReturnType<typeof startRoutesApi>> | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await api?.fake.close();
  api = undefined;
});

const ctx = (): ToolContext => ({ principal: principal('dev', ['test']), env: 'test', allowWrite: false, prodValidateEnabled: false, visible: [] });
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const queryOf = (url: string) => new URL(url, 'https://x').searchParams;

/** 352 rules: 350 flat (every third required) + 1 parent with 1 child = 352 flattened. */
const tree = (n = 350) => [
  ...Array.from({ length: n }, (_, i) => ({ id: String(i + 1), tag: 'X', parameter: `Document.Items[].Field${i}`, isRequired: i % 3 === 0, ruleCriterias: i % 3 === 0 ? ['Required'] : ['Optional'], dependencies: [] })),
  { id: '900', parameter: 'Document.Parent', isRequired: true, hasDependencies: true, dependencyOperator: 'AllRequired', ruleCriterias: ['HasDependencies (AllRequired): #901:X:Required:Child'], dependencies: [{ id: '901', parameter: 'Document.Child', isRequired: false, ruleCriterias: ['Weird: SECRET'], dependencies: [] }] },
];
const ok = (rules: unknown[] = tree()) => (_q: unknown, res: Parameters<typeof json>[0]) => json(res, 200, { channel: 'X', rules });

async function world(rules: unknown[] = tree(), ttlS = 3600, profiles: 'one' | 'two' = 'one') {
  api = await startRoutesApi(pki, { [RULES]: ok(rules) });
  const tp = twoProfiles(pki);
  const config = loadConfig(tp.env);
  const clients = realClients(pki, api.fake, config);
  const used: RulesToolDeps['clients'] = profiles === 'one' ? new Map([['a', clients.get('a')!]]) : clients;
  const tool = createGetRules({ clients: used, cache: createRulesCache({ ttlMs: ttlS * 1000 }) });
  return { ...api, tool };
}

describe('get_rules [fake-api]', () => {
  it('first page: readable, paginated, no raw vendor keys', async () => {
    const w = await world();
    const r = await w.tool.run({ channel: 'X' }, ctx());
    expect(r).toMatchObject({ profile: 'a', channel: 'X', templateStandardId: 0, total: 352, offset: 0, returned: 100, hasMore: true });
    expect(r.rules).toHaveLength(100);
    expect(r.rules[0]).toEqual({ id: '1', path: 'document.items[].field0', tag: 'X', required: true, hints: ['document.items[].field0 is required.'] });
    expect(JSON.stringify(r)).not.toMatch(/"parameter"|"ruleCriterias"|"dependencies"/);
    expect(getRulesOutput.parse(r)).toEqual(r);
  });
  it('last page and the page past the end', async () => {
    const w = await world();
    const last = await w.tool.run({ channel: 'X', offset: 300, limit: 100 }, ctx());
    expect([last.returned, last.hasMore, last.total]).toEqual([52, false, 352]);
    const exact = await w.tool.run({ channel: 'X', offset: 252, limit: 100 }, ctx());
    expect([exact.returned, exact.hasMore]).toEqual([100, false]);
    const one = await w.tool.run({ channel: 'X', offset: 251, limit: 100 }, ctx());
    expect([one.returned, one.hasMore]).toEqual([100, true]);
    const past = await w.tool.run({ channel: 'X', offset: 400 }, ctx());
    expect([past.returned, past.hasMore, past.rules]).toEqual([0, false, []]);
  });
  it('the default limit is 100 and the limit is honoured', async () => {
    const w = await world();
    expect((await w.tool.run({ channel: 'X', limit: 3 }, ctx())).returned).toBe(3);
    expect((await w.tool.run({ channel: 'X' }, ctx())).returned).toBe(100);
  });
  it('always requests templateStandardId, 0 by default, and nothing else', async () => {
    const w = await world();
    await w.tool.run({ channel: 'X' }, ctx());
    await w.tool.run({ channel: 'X', templateStandardId: 2 }, ctx());
    const [a, b] = w.requests(RULES).map((r) => queryOf(r.url));
    expect([...a!.entries()]).toEqual([['channel', 'X'], ['templateStandardId', '0']]);
    expect([...b!.entries()]).toEqual([['channel', 'X'], ['templateStandardId', '2']]);
  });
  it('caches per profile, channel and template', async () => {
    const w = await world(tree(), 3600, 'two');
    await w.tool.run({ channel: 'X', profile: 'a' }, ctx());
    await w.tool.run({ channel: 'X', profile: 'a', offset: 5 }, ctx());
    expect(w.requests(RULES)).toHaveLength(1);
    await w.tool.run({ channel: 'X', profile: 'a', templateStandardId: 2 }, ctx());
    await w.tool.run({ channel: 'Y', profile: 'a' }, ctx());
    await w.tool.run({ channel: 'X', profile: 'b' }, ctx());
    expect(w.requests(RULES)).toHaveLength(4);
  });
  it('a zero TTL fetches every time', async () => {
    const w = await world(tree(), 0);
    await w.tool.run({ channel: 'X' }, ctx());
    await w.tool.run({ channel: 'X' }, ctx());
    expect(w.requests(RULES)).toHaveLength(2);
  });
  it('a failed fetch is not cached', async () => {
    const w = await world();
    let n = 0;
    w.routes[RULES] = (_q, res) => (n++ === 0 ? json(res, 500, 'boom', 'text/plain') : ok()(_q, res));
    const e = await rejection(w.tool.run({ channel: 'X' }, ctx()));
    expect((e as { kind: string }).kind).toBe('upstream');
    expect((await w.tool.run({ channel: 'X' }, ctx())).total).toBe(352);
  });
  it('pathPrefix and requiredOnly filter locally, total counts the filtered rules', async () => {
    const w = await world([
      { id: '1', parameter: 'Document.Invoice.PaymentMeans', isRequired: true, dependencies: [] },
      { id: '2', parameter: 'Document.Invoice.PaymentMeans.Code', isRequired: false, dependencies: [] },
      { id: '3', parameter: 'Document.Invoice.PaymentMeans[].Id', isRequired: true, dependencies: [] },
      { id: '4', parameter: 'Document.Invoice.PaymentMeansExtra', isRequired: true, dependencies: [] },
      { id: '5', parameter: 'Document.Invoice.Other', isRequired: true, dependencies: [] },
    ]);
    const p = 'document.invoice.paymentMeans';
    const both = await w.tool.run({ channel: 'X', pathPrefix: p }, ctx());
    expect(both.rules.map((r) => r.id)).toEqual(['1', '2', '3']);
    const req = await w.tool.run({ channel: 'X', pathPrefix: p, requiredOnly: true }, ctx());
    expect(req.rules.map((r) => r.id)).toEqual(['1', '3']);
    expect(req.total).toBe(2);
    expect((await w.tool.run({ channel: 'X', requiredOnly: true }, ctx())).total).toBe(4);
    expect((await w.tool.run({ channel: 'X', requiredOnly: false }, ctx())).total).toBe(5);
    expect(w.requests(RULES)).toHaveLength(1);
  });
  it('flattens dependencies, counts children, names unknown criteria without vendor text', async () => {
    const w = await world();
    const r = await w.tool.run({ channel: 'X', pathPrefix: 'document.parent' }, ctx());
    expect(r.rules).toEqual([{ id: '900', path: 'document.parent', tag: undefined, required: true, hints: ['When document.parent is present, all of these must be present: document.child.'], dependsOn: { operator: 'all', rules: [{ id: '901', path: 'document.child' }] } }].map(({ tag: _t, ...x }) => x));
    const child = await w.tool.run({ channel: 'X', pathPrefix: 'document.child' }, ctx());
    expect(child.rules[0]!.hints).toEqual(['document.child has a rule of a kind this server does not know (rule 901).']);
    expect(JSON.stringify(child)).not.toContain('SECRET');
  });
  it('returned rules are copies: mutating them never changes a later answer', async () => {
    const w = await world();
    const first = await w.tool.run({ channel: 'X', pathPrefix: 'document.parent' }, ctx());
    first.rules[0]!.hints.push('X');
    first.rules[0]!.dependsOn!.rules[0]!.path = 'x';
    first.rules[0]!.required = false;
    const again = await w.tool.run({ channel: 'X', pathPrefix: 'document.parent' }, ctx());
    expect(again.rules[0]!.hints).toHaveLength(1);
    expect(again.rules[0]!.dependsOn!.rules[0]!.path).toBe('document.child');
    expect(again.rules[0]!.required).toBe(true);
  });
  it('profile selection: required, unknown, no upstream call', async () => {
    const w = await world(tree(), 3600, 'two');
    const a = await rejection(w.tool.run({ channel: 'X' }, ctx()));
    expect(a).toBeInstanceOf(ToolInputError);
    expect((a as Error).message).toBe('profile is required');
    const b = await rejection(w.tool.run({ channel: 'X', profile: 'nope' }, ctx()));
    expect((b as Error).message).toBe('unknown profile');
    expect(w.requests(RULES)).toHaveLength(0);
  });
  it('an upstream 400 surfaces as a typed error without upstream text', async () => {
    const w = await world();
    w.routes[RULES] = (_q, res) => json(res, 400, { type: 'x', title: 'UPSTREAM-TEXT', errors: { channel: ['UPSTREAM-DETAIL'] } }, 'application/problem+json');
    const e = (await rejection(w.tool.run({ channel: 'X' }, ctx()))) as { kind: string; message: string };
    expect(e.kind).toBe('bad_request');
    expect(e.message).not.toContain('UPSTREAM');
  });
});

describe('input schema', () => {
  it.each([[{ channel: '' }], [{ channel: 'X', limit: 0 }], [{ channel: 'X', limit: 201 }], [{ channel: 'X', offset: -1 }], [{ channel: 'X', templateStandardId: -1 }], [{ channel: 'X', templateStandardId: 1.5 }], [{ channel: 'X', pathPrefix: '' }], [{}]])('refuses %j', async (input) => {
    const { getRulesInput } = await import('./rules-tools.ts');
    expect(getRulesInput.safeParse(input).success).toBe(false);
  });
  it('accepts the bounds', async () => {
    const { getRulesInput } = await import('./rules-tools.ts');
    expect(getRulesInput.safeParse({ channel: 'X', limit: 1, offset: 0, templateStandardId: 0 }).success).toBe(true);
    expect(getRulesInput.safeParse({ channel: 'X', limit: 200 }).success).toBe(true);
  });
});

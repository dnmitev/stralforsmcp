/*
 * validate_invoice (03-01c Task 2), red. API under test: createValidateInvoice({ clients, config, cache, uuid? }) from ./validate-tool.ts,
 * spec { name: 'validate_invoice', access: 'validate' }. Routes-based fake API; synthetic data only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { json } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { RULES, VALIDATE, ctx, deepFreeze, doc, fault, queryOf, randomId, rule, validateWorld } from '../../test/helpers/validate.ts';
import { createRulesCache } from './rules-cache.ts';
import { createGetRules } from './rules-tools.ts';
import { ToolInputError } from './tools.ts';
import { createValidateInvoice } from './validate-tool.ts';

let pki: Pki;
let w: Awaited<ReturnType<typeof validateWorld>> | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const world = async (o: Parameters<typeof validateWorld>[1] = {}) => (w = await validateWorld(pki, o));
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const text = (r: { content: { type: string; text?: string }[] }) => r.content[0]!.text!;
const REQ_HEADER = rule('1', 'Document.DocumentHeader.TimeStamp', ['Required']);

describe('tool definition', () => {
  it('is named validate_invoice, access validate, no scope, read-only idempotent open-world annotations', async () => {
    const t = createValidateInvoice({ clients: new Map(), config: (await world()).config, cache: createRulesCache({ ttlMs: 0 }) });
    expect(t.spec).toEqual({ name: 'validate_invoice', access: 'validate' });
    expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  });
  it('input schema: document parts optional, consignmentId 10..50, strict output on findings', async () => {
    const t = (await world()).tool;
    expect(t.inputSchema.safeParse({ document: {} }).success).toBe(true);
    expect(t.inputSchema.safeParse({ document: { documentHeader: {}, invoice: {}, extra: 1 } }).success).toBe(true);
    expect(t.inputSchema.safeParse({ document: {}, consignmentId: 'x'.repeat(9) }).success).toBe(false);
    expect(t.inputSchema.safeParse({ document: {}, consignmentId: 'x'.repeat(51) }).success).toBe(false);
    expect(t.inputSchema.safeParse({ document: {}, consignmentId: 'x'.repeat(10) }).success).toBe(true);
    expect(t.inputSchema.safeParse({ document: {}, consignmentId: 'x'.repeat(50) }).success).toBe(true);
    expect(t.inputSchema.safeParse({}).success).toBe(false);
  });
  it('output validates against its own schema on every stage', async () => {
    const x = await world({ rules: { X: [REQ_HEADER] } });
    for (const d of [{ documentHeader: {} }, doc(), doc(['X'], {}, { timeStamp: 't' })]) {
      const r = await x.run({ document: d });
      expect(x.tool.outputSchema.parse(r)).toEqual(r);
    }
  });
});

describe('stage order and short circuit', () => {
  it('input stage: no rules and no validate request', async () => {
    const x = await world();
    const r = await x.run({ document: { documentHeader: { channelPriority: ['X'] } } });
    expect(r).toMatchObject({ valid: false, stage: 'input', moreMayFollow: true });
    expect(r.findings).toEqual([expect.objectContaining({ source: 'local', kind: 'shape', path: 'document.invoice' })]);
    expect(x.requests(RULES)).toHaveLength(0);
    expect(x.requests(VALIDATE)).toHaveLength(0);
  });
  it('both parts missing: one shape finding each, header first', async () => {
    const x = await world();
    const r = await x.run({ document: {} });
    expect(r.stage).toBe('input');
    expect(r.findings.map((f) => f.path)).toEqual(['document.documentHeader', 'document.invoice']);
    expect(x.fake.apiRequests).toHaveLength(0);
  });
  it.each([[undefined], [[]]])('channelPriority %j: one required finding, stage local, no request', async (cp) => {
    const x = await world();
    const header = cp === undefined ? {} : { channelPriority: cp };
    const r = await x.run({ document: { documentHeader: header, invoice: {} } });
    expect(r).toMatchObject({ valid: false, stage: 'local', moreMayFollow: true });
    expect(r.findings).toEqual([expect.objectContaining({ source: 'local', kind: 'required', path: 'document.documentHeader.channelPriority' })]);
    expect(x.fake.apiRequests).toHaveLength(0);
  });
  it('channelPriority with only non-strings counts as empty', async () => {
    const x = await world();
    const r = await x.run({ document: doc([1, null, {}]) });
    expect(r.findings.map((f) => f.kind)).toEqual(['required']);
    expect(x.fake.apiRequests).toHaveLength(0);
  });
  it('local findings stop before the dry run: rules requested once, validate never', async () => {
    const x = await world({ rules: { X: [REQ_HEADER] } });
    const r = await x.run({ document: doc() });
    expect(r).toMatchObject({ valid: false, stage: 'local' });
    expect(x.requests(RULES)).toHaveLength(1);
    expect(x.requests(VALIDATE)).toHaveLength(0);
  });
  it('clean local stage: one rules request, one validate request, test=true, valid after the 200', async () => {
    const x = await world({ rules: { X: [REQ_HEADER] } });
    const r = await x.run({ document: doc(['X'], {}, { timeStamp: 't' }) });
    expect(r).toMatchObject({ valid: true, stage: 'passed', findings: [], moreMayFollow: false });
    expect(x.requests(RULES)).toHaveLength(1);
    expect(x.requests(VALIDATE)).toHaveLength(1);
    expect(x.requests(VALIDATE)[0]!.method).toBe('PUT');
    expect(queryOf(x.requests(VALIDATE)[0]!.url).get('test')).toBe('true');
  });
  it('a dry-run rejection after a clean local stage is stage dry_run', async () => {
    const x = await world();
    x.routes[VALIDATE] = (_q, res) => json(res, 400, fault({ param: '#3:Document.DocumentHeader.ChannelPriority', value: 'ValidChannels: A, B' }));
    const r = await x.run({ document: doc() });
    expect(r).toMatchObject({ valid: false, stage: 'dry_run', moreMayFollow: true });
    expect(x.requests(VALIDATE)).toHaveLength(1);
  });
  it('channels are deduplicated, non-strings ignored: one rules request per distinct channel', async () => {
    const x = await world();
    await x.run({ document: doc(['X', 'X', 7, 'Y']) });
    expect(x.requests(RULES).map((r) => queryOf(r.url).get('channel')).sort()).toEqual(['X', 'Y']);
  });
  it.each([
    [{ standardId: 3 }, '3'], [{ standardId: 0 }, '0'], [{ standardId: -1 }, '0'], [{ standardId: 1.5 }, '0'], [{ standardId: '2' }, '0'], [undefined, '0'],
  ])('templateParameter %j requests templateStandardId %s', async (tp, expected) => {
    const x = await world();
    await x.run({ document: doc(['X'], {}, tp === undefined ? {} : { templateParameter: tp }) });
    expect(queryOf(x.requests(RULES)[0]!.url).get('templateStandardId')).toBe(expected);
  });
  it('more than 5 channels: shape finding on channelPriority, stage local, no upstream call; exactly 5 is fine', async () => {
    const x = await world();
    const r = await x.run({ document: doc(['A', 'B', 'C', 'D', 'E', 'F']) });
    expect(r).toMatchObject({ valid: false, stage: 'local', moreMayFollow: true });
    expect(r.findings).toEqual([expect.objectContaining({ source: 'local', kind: 'shape', path: 'document.documentHeader.channelPriority' })]);
    expect(x.fake.apiRequests).toHaveLength(0);
    expect((await x.run({ document: doc(['A', 'B', 'C', 'D', 'E']) })).valid).toBe(true);
    expect(x.requests(RULES)).toHaveLength(5);
  });
  it('six entries that dedupe to five are not too many', async () => {
    const x = await world();
    expect((await x.run({ document: doc(['A', 'B', 'C', 'D', 'E', 'A']) })).valid).toBe(true);
  });
});

describe('agreement and profile selection', () => {
  const run = (x: Awaited<ReturnType<typeof validateWorld>>, args: Record<string, unknown>) => rejection(x.tool.run({ document: doc(), ...args } as never, ctx()));
  it('several agreements and none named: "agreement is required", no request, before stage 1', async () => {
    const x = await world();
    const e = await rejection(x.tool.run({ profile: 'a', document: {} }, ctx()));
    expect(e).toBeInstanceOf(ToolInputError);
    expect((e as Error).message).toBe('agreement is required');
    expect(x.fake.apiRequests).toHaveLength(0);
  });
  it('unknown label: "unknown agreement"', async () => {
    const x = await world();
    const e = await run(x, { profile: 'a', agreement: 'nope' });
    expect(e).toBeInstanceOf(ToolInputError);
    expect((e as Error).message).toBe('unknown agreement');
    expect(x.fake.apiRequests).toHaveLength(0);
  });
  it('a label of another profile is unknown', async () => {
    const x = await world();
    expect(((await run(x, { profile: 'a', agreement: 'letters' })) as Error).message).toBe('unknown agreement');
  });
  it('the named label sends that agreement id as actionId', async () => {
    const x = await world();
    await x.tool.run({ profile: 'a', agreement: 'billing', document: doc() }, ctx());
    expect(x.bodies()[0]!.actionId).toBe(x.uuid.a);
  });
  it('a single labelled agreement is used without naming it', async () => {
    const x = await world();
    await x.run({ document: doc() });
    expect(x.bodies()[0]!.actionId).toBe(x.uuid.b);
  });
  it('a single unlabelled agreement is used too, and naming a label then is unknown', async () => {
    const id = randomId();
    const x = await world({ env: { STRALFORS_PROFILE_B_ACTION_IDS: id } });
    await x.run({ document: doc() });
    expect(x.bodies()[0]!.actionId).toBe(id);
    expect(((await run(x, { profile: 'b', agreement: 'letters' })) as Error).message).toBe('unknown agreement');
  });
  it('no agreements configured: "agreement is required"', async () => {
    const x = await world({ env: { STRALFORS_PROFILE_B_ACTION_IDS: undefined } });
    expect(((await run(x, { profile: 'b' })) as Error).message).toBe('agreement is required');
    expect(x.fake.apiRequests).toHaveLength(0);
  });
  it('profile texts match list_channels: required / unknown, audit reason bad_input, no request', async () => {
    const x = await world();
    expect(text(await x.call({ document: doc() }))).toBe('profile is required');
    expect(text(await x.call({ profile: 'zz', document: doc() }))).toBe('unknown profile');
    expect(text(await x.call({ profile: 'a', document: doc() }))).toBe('agreement is required');
    expect(text(await x.call({ profile: 'a', agreement: 'nope', document: doc() }))).toBe('unknown agreement');
    expect(x.audit.lines().map((l) => [l.outcome, l.reason])).toEqual(Array(4).fill(['error', 'bad_input']));
    expect(x.fake.apiRequests).toHaveLength(0);
  });
  it('neither agreement id nor label appears in result or audit', async () => {
    const x = await world();
    const r = await x.call({ profile: 'a', agreement: 'billing', document: doc() });
    const bad = await x.call({ profile: 'a', agreement: 'billing-nope', document: doc() });
    for (const s of [JSON.stringify(r), JSON.stringify(bad), x.audit.text()]) for (const n of [x.uuid.a, x.uuid.aNoLabel, 'billing']) expect(s).not.toContain(n);
  });
});

describe('consignmentId', () => {
  it('defaults to 10..50 characters, different per call, passed upstream and never echoed', async () => {
    const x = await world();
    const results = [await x.run({ document: doc() }), await x.run({ document: doc() })];
    const ids = x.bodies().map((b) => b.consignmentId);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id.length).toBeGreaterThanOrEqual(10);
      expect(id.length).toBeLessThanOrEqual(50);
      for (const r of results) expect(JSON.stringify(r)).not.toContain(id);
    }
  });
  it('is validate-<uuid> from the injected generator', async () => {
    const x = await world({ uuid: () => 'fixed-uuid' });
    await x.run({ document: doc() });
    expect(x.bodies()[0]!.consignmentId).toBe('validate-fixed-uuid');
  });
  it('a caller-supplied one is passed upstream unchanged and never echoed', async () => {
    const x = await world();
    const mine = `mine-${randomId()}`.slice(0, 40);
    const r = await x.run({ document: doc(), consignmentId: mine });
    expect(x.bodies()[0]!.consignmentId).toBe(mine);
    expect(JSON.stringify(r)).not.toContain(mine);
    const bad = await x.call({ document: { documentHeader: {} }, consignmentId: mine });
    expect(JSON.stringify(bad) + x.audit.text()).not.toContain(mine);
  });
  it('the document is passed upstream as given', async () => {
    const x = await world();
    const d = doc(['X'], { a: [1, { b: 2 }] }, { extra: 'y' });
    await x.run({ document: d });
    expect(x.bodies()[0]!.document).toEqual(d);
  });
});

describe('200 outcomes and privacy', () => {
  const GUID = 'GUID-CANARY-1234';
  const ACTION = 'ACTION-CANARY-1234';
  it.each([
    ['string-wrapped JSON', JSON.stringify(JSON.stringify({ isTest: true, guid: GUID, actionId: ACTION, document: doc() }))],
    ['plain JSON object', JSON.stringify({ isTest: true, guid: GUID, actionId: ACTION, document: doc() })],
    ['empty body', ''],
  ])('%s: valid true, stage passed, no guid and no actionId', async (_n, body) => {
    const x = await world();
    x.routes[VALIDATE] = (_q, res) => json(res, 200, body);
    const r = await x.run({ document: doc() });
    expect(r).toMatchObject({ valid: true, stage: 'passed', findings: [], moreMayFollow: false });
    const s = JSON.stringify(r);
    for (const n of [GUID, ACTION, 'guid', 'actionId']) expect(s).not.toContain(n);
  });
  it('no guid or actionId key in any output, including dry-run findings', async () => {
    const x = await world();
    x.routes[VALIDATE] = (_q, res) => json(res, 400, { ...fault({ param: '#3:Document.DocumentHeader.ChannelPriority', value: 'ValidChannels: A' }), DtoGuid: GUID, guid: GUID, actionId: ACTION });
    const s = JSON.stringify(await x.run({ document: doc() }));
    for (const n of [GUID, ACTION, 'DtoGuid', 'EXPLAIN-CANARY', 'FAULT-MESSAGE-CANARY', 'explanationText']) expect(s).not.toContain(n);
  });
});

describe('rules_unavailable', () => {
  it('a failed rules fetch alone: dry run still runs, result invalid at dry_run with a fixed finding that does not name the channel', async () => {
    const x = await world();
    x.routes[RULES] = (_q, res) => json(res, 403, { message: 'nope' });
    const r = await x.run({ document: doc(['CHAN-CANARY']) });
    expect(x.requests(VALIDATE)).toHaveLength(1);
    expect(r).toMatchObject({ valid: false, stage: 'dry_run', moreMayFollow: true });
    expect(r.findings).toEqual([expect.objectContaining({ source: 'local', kind: 'rules_unavailable' })]);
    expect(JSON.stringify(r)).not.toContain('CHAN-CANARY');
  });
  it('one finding per failing channel; the other channel is still checked and its findings stop the run at local', async () => {
    const x = await world({ rules: { Y: [REQ_HEADER] } });
    x.routes[RULES] = (req, res) => (queryOf(req.url!).get('channel') === 'X' ? json(res, 403, {}) : json(res, 200, { channel: 'Y', rules: [REQ_HEADER] }));
    const r = await x.run({ document: doc(['X', 'Y']) });
    expect(r.stage).toBe('local');
    expect(r.findings.map((f) => f.kind).sort()).toEqual(['required', 'rules_unavailable']);
    expect(x.requests(VALIDATE)).toHaveLength(0);
  });
  it('both channels failing: two findings, dry run runs, never valid', async () => {
    const x = await world();
    x.routes[RULES] = (_q, res) => json(res, 403, {});
    const r = await x.run({ document: doc(['X', 'Y']) });
    expect(r.findings.filter((f) => f.kind === 'rules_unavailable')).toHaveLength(2);
    expect(r.valid).toBe(false);
  });
  it('rules_unavailable findings are appended to dry-run findings', async () => {
    const x = await world();
    x.routes[RULES] = (_q, res) => json(res, 403, {});
    x.routes[VALIDATE] = (_q, res) => json(res, 400, fault({ param: '#3:Document.DocumentHeader.ChannelPriority', value: 'ValidChannels: A' }));
    const r = await x.run({ document: doc() });
    expect(r.stage).toBe('dry_run');
    expect(r.findings.map((f) => f.kind).sort()).toEqual(['rules_unavailable', 'valid_channels']);
  });
  it('a failed rules fetch is not cached: the next call fetches again', async () => {
    const x = await world();
    let n = 0;
    x.routes[RULES] = (_q, res) => (n++ === 0 ? json(res, 403, {}) : json(res, 200, { channel: 'X', rules: [REQ_HEADER] }));
    expect((await x.run({ document: doc() })).stage).toBe('dry_run');
    expect((await x.run({ document: doc() })).stage).toBe('local');
  });
  it('a non-Stralfors rejection from the rules fetch is rethrown, not turned into a finding', async () => {
    const x = await world();
    const boom = new TypeError('boom');
    const t = createValidateInvoice({ clients: new Map([['b', { rules: async () => { throw boom; }, validateInvoice: async () => undefined } as never]]), config: x.config, cache: createRulesCache({ ttlMs: 0 }) });
    expect(await rejection(t.run({ document: doc() }, ctx()))).toBe(boom);
  });
});

describe('error outcomes: tool failed: <kind>, audit reason = kind', () => {
  const KINDS: [string, (x: Awaited<ReturnType<typeof validateWorld>>) => void, string][] = [
    ['403', (x) => void (x.routes[VALIDATE] = (_q, r) => json(r, 403, { message: 'UP-CANARY' })), 'forbidden'],
    ['gateway 404 text', (x) => void (x.routes[VALIDATE] = (_q, r) => json(r, 404, 'No Mapping Rule matched', 'text/plain')), 'route_not_found'],
    ['401', (x) => void (x.routes[VALIDATE] = (_q, r) => json(r, 401, { message: 'UP-CANARY' })), 'auth'],
    ['409', (x) => void (x.routes[VALIDATE] = (_q, r) => json(r, 409, { message: 'UP-CANARY' })), 'conflict'],
    ['429', (x) => void (x.routes[VALIDATE] = (_q, r) => json(r, 429, { message: 'UP-CANARY' })), 'rate_limited'],
    ['500', (x) => void (x.routes[VALIDATE] = (_q, r) => json(r, 500, 'UP-CANARY', 'text/plain')), 'upstream'],
    ['schema', (x) => void (x.routes[VALIDATE] = (_q, r) => json(r, 200, { guid: 5 })), 'schema'],
  ];
  it.each(KINDS)('%s -> %s', async (_n, arm, kind) => {
    const x = await world();
    arm(x);
    const r = await x.callOnly({ document: doc() });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(`tool failed: ${kind}`);
    expect(x.audit.lines()[0]).toMatchObject({ outcome: 'error', reason: kind });
    expect(text(r) + x.audit.text()).not.toContain('UP-CANARY');
  });
  it('timeout -> tool failed: timeout', async () => {
    const x = await world({ env: { STRALFORS_TIMEOUT_MS: '100' } });
    x.routes[VALIDATE] = (_q, r) => void setTimeout(() => json(r, 200, ''), 600);
    const r = await x.callOnly({ document: doc() });
    expect(text(r)).toBe('tool failed: timeout');
    expect(x.audit.lines()[0]).toMatchObject({ reason: 'timeout' });
  });
  it('untrusted server certificate -> tool failed: tls', async () => {
    const x = await world({ serverCert: 'selfSigned' });
    expect(text(await x.callOnly({ document: doc() }))).toBe('tool failed: tls');
  });
  it('404 ErrorResponse -> "agreement not found for this profile", audit bad_input (documented deviation), ids nowhere', async () => {
    const x = await world();
    const identity = randomId();
    x.routes[VALIDATE] = (_q, r) => json(r, 404, { message: `Action id '${x.uuid.b}' not found for identity '${identity}'` });
    const r = await x.callOnly({ document: doc() });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('agreement not found for this profile');
    expect(x.audit.lines()[0]).toMatchObject({ outcome: 'error', reason: 'bad_input' });
    for (const n of [x.uuid.b, identity, 'letters']) expect(JSON.stringify(r) + x.audit.text()).not.toContain(n);
  });
  it('a missing key, a 400 without compositeFault and local-only errors never reach callTool as errors', async () => {
    const x = await world();
    x.routes[VALIDATE] = (_q, r) => json(r, 400, { errors: { 'document.invoice.issueDate': ['UP-CANARY'] } }, 'application/problem+json');
    const r = await x.callOnly({ document: doc() });
    expect(r.isError).toBeFalsy();
    expect(x.audit.lines()[0]).toMatchObject({ outcome: 'allowed' });
  });
});

describe('limits', () => {
  it('more than 100 local findings: 100 sorted findings plus one truncated finding naming the omitted count, under the output cap', async () => {
    const rules = Array.from({ length: 150 }, (_, i) => rule(String(i + 1), `Document.Invoice.F${String(i).padStart(3, '0')}`, ['Required']));
    const x = await world({ rules: { X: rules } });
    const r = await x.run({ document: doc() });
    expect(r.stage).toBe('local');
    expect(r.findings).toHaveLength(101);
    const head = r.findings.slice(0, 100);
    expect(head.every((f) => f.kind === 'required')).toBe(true);
    expect(head.map((f) => f.path)).toEqual(head.map((f) => f.path).sort());
    expect(head[0]!.path).toBe('document.invoice.f000');
    const last = r.findings[100]!;
    expect(last.kind).toBe('truncated');
    expect(last.message).toContain('50');
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(262_144);
  });
  it('exactly 100 findings are not truncated', async () => {
    const rules = Array.from({ length: 100 }, (_, i) => rule(String(i + 1), `Document.Invoice.F${String(i).padStart(3, '0')}`, ['Required']));
    const x = await world({ rules: { X: rules } });
    const r = await x.run({ document: doc() });
    expect(r.findings).toHaveLength(100);
    expect(r.findings.some((f) => f.kind === 'truncated')).toBe(false);
  });
  it('dry-run findings are capped the same way', async () => {
    const x = await world();
    const pv = Array.from({ length: 130 }, (_, i) => ({ param: `#${i + 1}:Document.Invoice.F${String(i).padStart(3, '0')}`, value: 'Required' }));
    x.routes[VALIDATE] = (_q, r) => json(r, 400, fault(...pv));
    const r = await x.run({ document: doc() });
    expect(r.findings).toHaveLength(101);
    expect(r.findings[100]).toMatchObject({ kind: 'truncated' });
    expect(r.findings[100]!.message).toContain('30');
  });
});

describe('document is never mutated', () => {
  it('a deep-frozen document passes through local findings, a pass, and dry-run findings', async () => {
    const x = await world({ rules: { X: [rule('1', 'Document.Invoice.Line[].Id', ['Required'])] } });
    const d = deepFreeze(doc(['X'], { line: [{ id: '1' }, {}] }));
    expect((await x.run({ document: d })).stage).toBe('local');
    const ok = deepFreeze(doc(['X'], { line: [{ id: '1' }] }));
    expect((await x.run({ document: ok })).valid).toBe(true);
    x.routes[VALIDATE] = (_q, r) => json(r, 400, fault({ param: '#3:Document.Invoice.Line[].Id', value: 'Required' }));
    expect((await x.run({ document: ok })).stage).toBe('dry_run');
    expect(JSON.stringify(ok)).toBe(JSON.stringify(doc(['X'], { line: [{ id: '1' }] })));
  });
});

describe('rules cache shared with get_rules', () => {
  it('get_rules first, then validate_invoice: one rules request', async () => {
    const cache = createRulesCache({ ttlMs: 3_600_000 });
    const x = await world({ cache, rules: { X: [REQ_HEADER] } });
    await createGetRules({ clients: x.clients, cache }).run({ profile: 'b', channel: 'X' }, ctx());
    expect((await x.run({ document: doc() })).stage).toBe('local');
    expect(x.requests(RULES)).toHaveLength(1);
  });
  it('validate_invoice first, then get_rules: one rules request, same rules', async () => {
    const cache = createRulesCache({ ttlMs: 3_600_000 });
    const x = await world({ cache, rules: { X: [REQ_HEADER] } });
    await x.run({ document: doc() });
    const r = await createGetRules({ clients: x.clients, cache }).run({ profile: 'b', channel: 'X' }, ctx());
    expect(r.rules.map((q) => q.path)).toEqual(['document.documentHeader.timeStamp']);
    expect(x.requests(RULES)).toHaveLength(1);
  });
  it('a different template is a different cache entry', async () => {
    const x = await world();
    await x.run({ document: doc() });
    await x.run({ document: doc(['X'], {}, { templateParameter: { standardId: 2 } }) });
    expect(x.requests(RULES)).toHaveLength(2);
  });
});

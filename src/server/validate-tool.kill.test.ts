// Mutation-killing cases for validate_invoice. Synthetic data only.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { json } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { RULES, VALIDATE, doc, fault, queryOf, rule, validateWorld } from '../../test/helpers/validate.ts';
import { validateInput, validateOutput } from './validate-tool.ts';

let pki: Pki;
let w: Awaited<ReturnType<typeof validateWorld>> | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const world = async (o: Parameters<typeof validateWorld>[1] = {}) => (w = await validateWorld(pki, o));
const pv = (id: string, path: string, value: string) => ({ param: `#${id}:${path}`, value });

describe('definition and schemas', () => {
  it('title, description and input bounds', async () => {
    const t = (await world()).tool;
    expect(t.title).toBe('Validate invoice');
    expect(t.description).toContain('moreMayFollow');
    expect(t.description).toContain('creates nothing');
    expect(validateInput.safeParse({ document: {}, profile: '' }).success).toBe(false);
    expect(validateInput.safeParse({ document: {}, profile: 'abc' }).success).toBe(true);
    expect(validateInput.safeParse({ document: {}, agreement: '' }).success).toBe(false);
    expect(validateInput.safeParse({ document: 'x' }).success).toBe(false);
    expect(validateInput.safeParse({ document: { documentHeader: 'x' } }).success).toBe(false);
    expect(validateInput.safeParse({ document: { invoice: [] } }).success).toBe(false);
  });
  it('output accepts every stage and source, serverError true, and nothing else', () => {
    for (const stage of ['input', 'local', 'dry_run', 'passed'] as const) expect(validateOutput.safeParse({ valid: false, stage, findings: [], moreMayFollow: true }).success, stage).toBe(true);
    expect(validateOutput.safeParse({ valid: false, stage: 'other', findings: [], moreMayFollow: true }).success).toBe(false);
    for (const source of ['local', 'stralfors'] as const) expect(validateOutput.safeParse({ valid: false, stage: 'local', moreMayFollow: true, findings: [{ source, path: '', kind: 'k', message: 'm' }] }).success, source).toBe(true);
    const f = { source: 'stralfors', path: '', kind: 'rule_engine', message: 'm' };
    expect(validateOutput.safeParse({ valid: false, stage: 'dry_run', moreMayFollow: true, findings: [{ ...f, serverError: true }] }).success).toBe(true);
    expect(validateOutput.safeParse({ valid: false, stage: 'dry_run', moreMayFollow: true, findings: [{ ...f, serverError: false }] }).success).toBe(false);
    expect(validateOutput.safeParse({ valid: false, stage: 'dry_run', moreMayFollow: true, findings: [{ ...f, source: 'x' }] }).success).toBe(false);
    expect(validateOutput.safeParse({ valid: false, stage: 'dry_run', moreMayFollow: true, findings: [{ ...f, extra: 1 }] }).success).toBe(false);
  });
});

describe('fixed messages', () => {
  it('missing, empty and too many channels', async () => {
    const x = await world();
    const none = await x.run({ document: { documentHeader: {}, invoice: {} } });
    expect(none.findings).toEqual([{ source: 'local', path: 'document.documentHeader.channelPriority', kind: 'required', message: 'document.documentHeader.channelPriority is required.' }]);
    const many = await x.run({ document: doc(['A', 'B', 'C', 'D', 'E', 'F']) });
    expect(many.findings).toEqual([{ source: 'local', path: 'document.documentHeader.channelPriority', kind: 'shape', message: 'document.documentHeader.channelPriority may list at most 5 channels.' }]);
    expect(x.requests(RULES)).toHaveLength(0);
    expect((await x.run({ document: doc(['A', 'B', 'C', 'D', 'E']) })).stage).toBe('passed');
  });
  it('only the missing part is named', async () => {
    const x = await world();
    expect((await x.run({ document: { invoice: {} } })).findings.map((f) => f.path)).toEqual(['document.documentHeader']);
    expect((await x.run({ document: { documentHeader: { channelPriority: ['X'] } } })).findings.map((f) => f.path)).toEqual(['document.invoice']);
  });
  it('an unloadable channel: fixed sentence, still dry-runs, and a failing dry run keeps it', async () => {
    const x = await world();
    x.routes[RULES] = (req, res) => (queryOf(req.url!).get('channel') === 'Y' ? json(res, 500, 'boom') : json(res, 200, { channel: 'X', rules: [] }));
    const unavailable = { source: 'local', path: '', kind: 'rules_unavailable', message: 'The rules of one channel could not be loaded, so they were not checked locally; the dry run still decides.' };
    const ok = await x.run({ document: doc(['X', 'Y']) });
    expect(ok).toMatchObject({ valid: false, stage: 'dry_run', moreMayFollow: true });
    expect(ok.findings).toEqual([unavailable]);
    x.routes[VALIDATE] = (_q, res) => json(res, 400, fault(pv('3', 'Document.Invoice.A', 'Required')));
    const bad = await x.run({ document: doc(['X', 'Y']) });
    expect(bad.findings.map((f) => f.kind)).toEqual(['rules_unavailable', 'required']);
    expect(bad.findings[0]).toEqual(unavailable);
  });
  it('an unloadable channel next to a local finding keeps the sentence at the local stage', async () => {
    const x = await world({ rules: { X: [rule('1', 'Document.Invoice.A', ['Required'])] } });
    const base = x.routes[RULES]!;
    x.routes[RULES] = (req, res) => (queryOf(req.url!).get('channel') === 'Y' ? json(res, 500, 'boom') : base(req, res));
    const r = await x.run({ document: doc(['X', 'Y']) });
    expect(r.stage).toBe('local');
    expect(r.findings.map((f) => f.kind)).toEqual(['rules_unavailable', 'required']); // path '' sorts before 'document...'
  });
});

describe('ordering and truncation', () => {
  it('findings are sorted by path, then rule id, equal ones keep their order', async () => {
    const x = await world();
    x.routes[VALIDATE] = (_q, res) => json(res, 400, fault(
      pv('9', 'Document.Invoice.B', 'Required'), pv('2', 'Document.Invoice.A', 'Required'), pv('10', 'Document.Invoice.A', 'Required'), pv('1', 'Document.Invoice.A', 'Required'),
      pv('5', 'Document.Invoice.C', 'Required | NumericExpected'),
    ));
    const r = await x.run({ document: doc() });
    expect(r.findings.map((f) => `${f.path}#${f.ruleId}#${f.kind}`)).toEqual([
      'document.invoice.a#1#required', 'document.invoice.a#10#required', 'document.invoice.a#2#required', 'document.invoice.b#9#required',
      'document.invoice.c#5#required', 'document.invoice.c#5#numeric',
    ]);
  });
  it('a finding without a rule id sorts before one with an id on the same path', async () => {
    const x = await world();
    x.routes[VALIDATE] = (_q, res) => json(res, 400, fault(pv('3', 'Document.Invoice.A', 'Required'), { param: 'Document.Invoice.A', value: 'Required' }, pv('1', 'Document.Invoice.A', 'Required')));
    const r = await x.run({ document: doc() });
    expect(r.findings.map((f) => f.ruleId)).toEqual([undefined, '1', '3']);
  });
  it('rule ids sort the same from ascending, descending and mixed input, with and without an id', async () => {
    const x = await world();
    const orders: string[][] = [['1', '2', '3'], ['3', '2', '1'], ['2', '3', '1'], ['2', '1', '3']];
    for (const ids of orders) {
      x.routes[VALIDATE] = (_q, res) => json(res, 400, fault(...ids.map((i) => pv(i, 'Document.Invoice.A', 'Required'))));
      expect((await x.run({ document: doc() })).findings.map((f) => f.ruleId), ids.join()).toEqual(['1', '2', '3']);
    }
    const bare = { param: 'Document.Invoice.A', value: 'Required' };
    for (const list of [[bare, pv('1', 'Document.Invoice.A', 'Required')], [pv('1', 'Document.Invoice.A', 'Required'), bare], [pv('1', 'Document.Invoice.A', 'Required'), bare, pv('2', 'Document.Invoice.A', 'Required')]]) {
      x.routes[VALIDATE] = (_q, res) => json(res, 400, fault(...list));
      const ids = (await x.run({ document: doc() })).findings.map((f) => f.ruleId);
      expect(ids[0]).toBeUndefined();
      expect(ids.slice(1)).toEqual(ids.slice(1).sort());
    }
  });
  it('more than 100 dry-run findings: 100 kept, one truncated finding with the exact count', async () => {
    const x = await world();
    x.routes[VALIDATE] = (_q, res) => json(res, 400, fault(...Array.from({ length: 107 }, (_, i) => pv(String(i + 1), `Document.Invoice.F${String(i).padStart(3, '0')}`, 'Required'))));
    const r = await x.run({ document: doc() });
    expect(r.findings).toHaveLength(101);
    expect(r.findings[100]).toEqual({ source: 'local', path: '', kind: 'truncated', message: '7 more findings were omitted; fix these and validate again.' });
    const x100 = Array.from({ length: 100 }, (_, i) => pv(String(i + 1), `Document.Invoice.F${String(i).padStart(3, '0')}`, 'Required'));
    x.routes[VALIDATE] = (_q, res) => json(res, 400, fault(...x100));
    expect((await x.run({ document: doc() })).findings).toHaveLength(100);
  });
});

describe('request-shape errors and the standard id', () => {
  it('a request the client refuses is a dry_run shape finding naming the field', async () => {
    const x = await world();
    const r = await x.run({ document: doc(), consignmentId: 'short' });
    expect(r).toMatchObject({ valid: false, stage: 'dry_run', moreMayFollow: true });
    expect(r.findings).toEqual([{ source: 'local', path: 'consignmentId', kind: 'shape', message: 'consignmentId is missing or has the wrong type.' }]);
    expect(x.requests(VALIDATE)).toHaveLength(0);
  });
  it.each<[unknown, string]>([[7, '7'], [0, '0'], [-1, '0'], [1.5, '0'], ['7', '0'], [undefined, '0']])('templateParameter.standardId %j asks for rules with templateStandardId %s', async (sid, sent) => {
    const x = await world();
    await x.run({ document: doc(['X'], {}, sid === undefined ? {} : { templateParameter: { standardId: sid } }) });
    expect(queryOf(x.requests(RULES)[0]!.url).get('templateStandardId')).toBe(sent);
  });
});

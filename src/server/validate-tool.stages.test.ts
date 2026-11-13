/* validate_invoice, scenarios of AC-4 (local stage) and AC-5 (dry-run mapping) end to end through the tool. Synthetic rules and faults only. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { json } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { RULES, VALIDATE, doc, fault, queryOf, rule, validateWorld } from '../../test/helpers/validate.ts';

let pki: Pki;
let w: Awaited<ReturnType<typeof validateWorld>> | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const world = async (o: Parameters<typeof validateWorld>[1] = {}) => (w = await validateWorld(pki, o));
const arm = (x: Awaited<ReturnType<typeof validateWorld>>, status: number, body: unknown, type?: string) => void (x.routes[VALIDATE] = (_q, r) => json(r, status, body, type));
const PV = (param: string, value: string) => ({ param, value });

describe('local stage', () => {
  it('Required on the header: the exact finding, stop before the dry run', async () => {
    const x = await world({ rules: { X: [rule('11', 'Document.DocumentHeader.TimeStamp', ['Required'])] } });
    const r = await x.run({ document: doc() });
    expect(r).toMatchObject({ valid: false, stage: 'local', moreMayFollow: true });
    expect(r.findings).toEqual([{ source: 'local', ruleId: '11', path: 'document.documentHeader.timeStamp', kind: 'required', message: 'document.documentHeader.timeStamp is required.' }]);
    expect(x.requests(VALIDATE)).toHaveLength(0);
  });
  it('a pattern violation carries expected and example', async () => {
    const x = await world({ rules: { X: [rule('12', 'Document.Invoice.Code', ['ExpectedPattern: ^[A-Z]{3}$', 'ExampleValue: ABC'])] } });
    const r = await x.run({ document: doc(['X'], { code: 'abc' }) });
    expect(r.findings).toEqual([expect.objectContaining({ kind: 'pattern', path: 'document.invoice.code', expected: '^[A-Z]{3}$', example: 'ABC' })]);
  });
  it('array path: element index in the path, two of three flagged', async () => {
    const x = await world({ rules: { X: [rule('13', 'Document.Invoice.Line[].Id', ['Required'])] } });
    const r = await x.run({ document: doc(['X'], { line: [{}, { id: 'a' }, {}] }) });
    expect(r.findings.map((f) => f.path)).toEqual(['document.invoice.line[0].id', 'document.invoice.line[2].id']);
  });
  it('a rule whose ancestor is absent is left to the dry run', async () => {
    const x = await world({ rules: { X: [rule('14', 'Document.Invoice.Seller.Name', ['Required'])] } });
    const r = await x.run({ document: doc() });
    expect(r).toMatchObject({ valid: true, stage: 'passed' });
    expect(x.requests(VALIDATE)).toHaveLength(1);
  });
  it('Required plus OptionalWhen on one path: no finding', async () => {
    const x = await world({ rules: { X: [rule('15', 'Document.Invoice.Ref', ['Required', 'OptionalWhen: other is set'])] } });
    expect((await x.run({ document: doc() })).valid).toBe(true);
  });

  type Row = [kind: string, criteria: string[], bad: unknown, good: unknown];
  const ROWS: Row[] = [
    ['valid_items', ['ValidItems: A, B'], 'Z', 'A'],
    ['valid_templates', ['ValidTemplates: 1, 2'], 5, 2],
    ['numeric', ['NumericExpected'], '1x', '123'],
    ['decimal', ['DecimalExpected'], 'abc', '1.5'],
    ['min_value', ['MinValue: 5'], 3, 5],
    ['max_value', ['MaxValue: 5'], 9, 5],
    ['max_count', ['MaxCount: Maximum items is 2.'], [1, 2, 3], [1, 2]],
    ['unique', ['UniqueValueExpected'], ['a', 'a'], ['a', 'b']],
    ['date_not_past', ['DateNotInPastExpected'], '2000-01-01', '2999-01-01'],
    ['array', ['ArrayExpected'], 'x', ['x']],
  ];
  describe.each(ROWS)('%s', (kind, criteria, bad, good) => {
    it('flags a clear violation at the local stage', async () => {
      const x = await world({ rules: { X: [rule('20', 'Document.Invoice.V', criteria)] } });
      const r = await x.run({ document: doc(['X'], { v: bad }) });
      expect(r).toMatchObject({ valid: false, stage: 'local' });
      expect(r.findings).toEqual([expect.objectContaining({ source: 'local', ruleId: '20', kind, path: 'document.invoice.v' })]);
    });
    it('passes a conforming value through to a valid dry run', async () => {
      const x = await world({ rules: { X: [rule('20', 'Document.Invoice.V', criteria)] } });
      expect(await x.run({ document: doc(['X'], { v: good }) })).toMatchObject({ valid: true, stage: 'passed', findings: [] });
    });
  });
  it('exclusive: both fields set is flagged, one is not', async () => {
    const x = await world({ rules: { X: [rule('21', 'Document.Invoice.A', ['CanNotBeCombinedWith: B'])] } });
    expect((await x.run({ document: doc(['X'], { a: '1', b: '2' }) })).findings.map((f) => f.kind)).toEqual(['exclusive']);
    expect((await x.run({ document: doc(['X'], { a: '1' }) })).valid).toBe(true);
  });
  it.each([
    ['unparseable regex', ['ExpectedPattern: ([']], ['non-numeric bound', ['MinValue: abc']], ['unknown criterion', ['SomethingNew: x']],
  ])('%s: no finding', async (_n, criteria) => {
    const x = await world({ rules: { X: [rule('22', 'Document.Invoice.V', criteria)] } });
    expect((await x.run({ document: doc(['X'], { v: 'q' }) })).valid).toBe(true);
  });
  it('two channels: both rule sets applied once each, a rule listed twice yields one finding', async () => {
    const shared = rule('30', 'Document.Invoice.S', ['Required']);
    const x = await world({ rules: { X: [shared, rule('31', 'Document.Invoice.OnlyX', ['Required'])], Y: [shared, rule('32', 'Document.Invoice.OnlyY', ['Required'])] } });
    const r = await x.run({ document: doc(['X', 'Y']) });
    expect(r.findings.map((f) => [f.ruleId, f.path])).toEqual([['31', 'document.invoice.onlyX'], ['32', 'document.invoice.onlyY'], ['30', 'document.invoice.s']].sort((a, b) => (a[1]! < b[1]! ? -1 : 1)));
    expect(x.requests(RULES)).toHaveLength(2);
  });
  it('templateStandardId reaches every channel request', async () => {
    const x = await world();
    await x.run({ document: doc(['X', 'Y'], {}, { templateParameter: { standardId: 4 } }) });
    expect(x.requests(RULES).map((r) => queryOf(r.url).get('templateStandardId'))).toEqual(['4', '4']);
  });
  it('a tagged rule keeps its tag in the finding', async () => {
    const x = await world({ rules: { X: [rule('33', 'Document.Invoice.T', ['Required'], { tag: 'Template0' })] } });
    expect((await x.run({ document: doc() })).findings[0]).toMatchObject({ tag: 'Template0', ruleId: '33' });
  });
});

describe('dry-run mapping', () => {
  it('compositeFault with channel lists: valid_channels and default_channel findings, example attached, no vendor text', async () => {
    const x = await world();
    arm(x, 400, fault(PV('#3:Document.DocumentHeader.ChannelPriority', 'ValidChannels: A, B | ValidDefaultChannel: A | ExampleValue: A')));
    const r = await x.run({ document: doc() });
    expect(r).toMatchObject({ valid: false, stage: 'dry_run', moreMayFollow: true });
    const vc = r.findings.find((f) => f.kind === 'valid_channels')!;
    expect(vc).toMatchObject({ source: 'stralfors', ruleId: '3', path: 'document.documentHeader.channelPriority', example: 'A' });
    expect(vc.message).toContain('A, B');
    expect(r.findings.find((f) => f.kind === 'default_channel')).toMatchObject({ source: 'stralfors', ruleId: '3', example: 'A' });
    const s = JSON.stringify(r);
    for (const n of ['EXPLAIN-CANARY', 'FAULT-MESSAGE-CANARY', 'explanationText', 'DtoGuid']) expect(s).not.toContain(n);
  });
  it('rule-engine exception text: serverError finding with the fixed sentence, exception words never returned', async () => {
    const x = await world();
    arm(x, 400, fault(PV('#77:Document.Invoice.Total', 'Unexpected error occurred: NullReferenceException at Rules.Engine')));
    const r = await x.run({ document: doc() });
    expect(r.findings).toEqual([expect.objectContaining({ serverError: true, ruleId: '77', path: 'document.invoice.total' })]);
    expect(r.findings[0]!.message).toContain('rule 77');
    const s = JSON.stringify(r);
    for (const n of ['NullReference', 'Exception', 'Engine.']) expect(s).not.toContain(n);
  });
  it('a Template0 param gives the tag and the camelCase path', async () => {
    const x = await world();
    arm(x, 400, fault(PV('#105:Template0:Document.Invoice.AdditionalDocumentReference[].Id.Value', 'Required')));
    const r = await x.run({ document: doc() });
    expect(r.findings[0]).toMatchObject({ ruleId: '105', tag: 'Template0', path: 'document.invoice.additionalDocumentReference[].id.value', kind: 'required' });
  });
  it('an empty criteria list gives kind unknown with the fixed sentence', async () => {
    const x = await world();
    arm(x, 400, fault(PV('#9:Document.Invoice.X', '')));
    const r = await x.run({ document: doc() });
    expect(r.findings).toEqual([expect.objectContaining({ kind: 'unknown', ruleId: '9', path: 'document.invoice.x' })]);
    expect(r.findings[0]!.message).toContain('rule 9');
  });
  it('a param off the grammar with free text: path empty, kind unknown, text not echoed', async () => {
    const x = await world();
    arm(x, 400, fault(PV('Free text with SECRET-WORDS inside', 'Required')));
    const r = await x.run({ document: doc() });
    expect(r.findings).toEqual([expect.objectContaining({ path: '', kind: 'unknown' })]);
    expect(JSON.stringify(r)).not.toContain('SECRET-WORDS');
  });
  it('findings are sorted by path then rule id', async () => {
    const x = await world();
    arm(x, 400, fault(PV('#5:Document.Invoice.B', 'Required'), PV('#4:Document.Invoice.B', 'Required'), PV('#6:Document.Invoice.A', 'Required')));
    const r = await x.run({ document: doc() });
    expect(r.findings.map((f) => `${f.path}#${f.ruleId}`)).toEqual(['document.invoice.a#6', 'document.invoice.b#4', 'document.invoice.b#5']);
  });
  it('a 400 problem+json with errors: one shape finding per key, upstream text dropped', async () => {
    const x = await world();
    arm(x, 400, { type: 'x', title: 'UP-TITLE', errors: { 'document.invoice.issueDate': ['any text UP-DETAIL'] } }, 'application/problem+json');
    const r = await x.run({ document: doc() });
    expect(r).toMatchObject({ valid: false, stage: 'dry_run', moreMayFollow: true });
    expect(r.findings).toEqual([expect.objectContaining({ source: 'stralfors', kind: 'shape', path: 'document.invoice.issueDate' })]);
    expect(JSON.stringify(r)).not.toMatch(/UP-TITLE|UP-DETAIL|any text/);
  });
  it('the dry run is one round: a single validate request even when it fails', async () => {
    const x = await world();
    arm(x, 400, fault(PV('#1:Document.Invoice.A', 'Required')));
    await x.run({ document: doc() });
    expect(x.requests(VALIDATE)).toHaveLength(1);
  });
});

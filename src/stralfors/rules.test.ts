// Synthetic criteria in the documented grammar (ADR 0004): one case per row of the criterion table.
import { describe, expect, it } from 'vitest';
import { criteriaOf, flattenRules, hintFor, hintsFor, parseCriterion, toJsonPath, type RuleNode } from './rules.ts';

const P = 'document.a.b';
const rule = (over: Partial<RuleNode> = {}): RuleNode => ({ id: '7', parameter: 'Document.A.B', ...over });

describe('toJsonPath', () => {
  it('lowers the first letter of each segment, keeps []', () => {
    expect(toJsonPath('Document.Invoice.PaymentMeans[].PaymentId')).toBe('document.invoice.paymentMeans[].paymentId');
    expect(toJsonPath('Document')).toBe('document');
    expect(toJsonPath('')).toBe('');
    expect(toJsonPath('A.BC.dEF')).toBe('a.bC.dEF');
  });
});

const BIG = '79228162514264337593543950335';
const CASES: Array<[string, string, object, string | undefined]> = [
  ['Required', 'required', {}, `${P} is required.`],
  ['Optional', 'optional', {}, `${P} is optional.`],
  ['ArrayExpected', 'array', {}, `${P} must be an array.`],
  ['ArrayWithValidItemsExpected', 'array_items', {}, `${P} must be an array; every item must satisfy its own rules.`],
  ['ValidItems: a, b ,c,', 'valid_items', { values: ['a', 'b', 'c'] }, `${P} must be one of: a, b, c.`],
  ['ValidTemplates: 0, 2, 3', 'valid_templates', { values: ['0', '2', '3'] }, `${P} must be one of the standard templates 0, 2, 3.`],
  ['ValidChannels: X, Y', 'valid_channels', { values: ['X', 'Y'] }, `${P} must only contain channels the agreement allows: X, Y.`],
  ['ValidDefaultChannel: some prose', 'default_channel', {}, 'The agreement defines the default channel; the first entry of channelPriority must match it.'],
  ['ExpectedPattern: ^\\d{5}$', 'pattern', { pattern: '^\\d{5}$' }, `${P} must match the pattern ^\\d{5}$.`],
  ['ExampleValue: 12345', 'example', { text: '12345' }, undefined],
  ['NumericExpected', 'numeric', {}, `${P} must contain digits only.`],
  ['DecimalExpected', 'decimal', {}, `${P} must be a decimal number.`],
  ['MinValue: 0', 'min_value', { n: '0' }, `${P} must be at least 0.`],
  ['MaxValue: -1.5', 'max_value', { n: '-1.5' }, `${P} must be at most -1.5.`],
  [`MinValue: -${BIG}`, 'min_value', { n: `-${BIG}` }, undefined],
  [`MaxValue: ${BIG}`, 'max_value', { n: BIG }, undefined],
  [`MaxValue: ${BIG}.0`, 'max_value', { n: `${BIG}.0` }, undefined],
  ['MaxCount: Maximum lines is 25.', 'max_count', { n: '25' }, `${P} may contain at most 25 items.`],
  ['UniqueValueExpected', 'unique', {}, `Values of ${P} must be unique within the array.`],
  ['ExactCasingExpected: x', 'exact_casing', {}, `${P} is case-sensitive; use the exact spelling from the allowed values.`],
  ['DateNotInPastExpected', 'date_not_past', {}, `${P} must not be a date in the past.`],
  ['StartDateNotPastEndDateExpected', 'period_order', { part: 'date' }, `The start date of ${P} must not be after its end date.`],
  ['StartTimeNotPastEndTimeExpected', 'period_order', { part: 'time' }, `The start time of ${P} must not be after its end time.`],
  ['FileNameExpected', 'file_name', {}, `${P} must be a valid file name with an extension.`],
  ['CanNotBeCombinedWith: Other', 'exclusive', { field: 'Other' }, `${P} cannot be set together with Other.`],
  ['OptionalWhen: Foo = 1', 'optional_when', { expr: 'Foo = 1' }, `${P} is optional when Foo = 1.`],
  ['RequiredWhen: Foo = 2', 'required_when', { expr: 'Foo = 2' }, `${P} is required when Foo = 2.`],
  ['InvalidWhen: Foo = 3', 'invalid_when', { expr: 'Foo = 3' }, `${P} is invalid when Foo = 3.`],
  ['ValidationCriteria: Must be short', 'criteria', { prose: 'Must be short' }, 'Rule note: Must be short.'],
  ['ValidationCriteria: Must be short.', 'criteria', { prose: 'Must be short.' }, 'Rule note: Must be short.'],
  ['ValidationCriteria: (O1E)', 'criteria', { prose: '(O1E)' }, 'Rule note: one of the keyed fields must exist.'],
  ['ValidationCriteria: x (VPDF)', 'criteria', { prose: 'x (VPDF)' }, 'Rule note: must be a PDF meeting the print criteria.'],
  ['ValidationCriteria: (CT)', 'criteria', { prose: '(CT)' }, 'Rule note: credit notes only.'],
  ['ValidationCriteria: (VAB)', 'criteria', { prose: '(VAB)' }, 'Rule note: must differ from the buyer.'],
  ['ValidationCriteria: (VAS)', 'criteria', { prose: '(VAS)' }, 'Rule note: must differ from the seller.'],
  ['ValidationCriteria: VID', 'criteria', { prose: 'VID' }, 'Rule note: VID.'],
];
describe('parseCriterion + hintFor, one row per kind', () => {
  it.each(CASES)('%s', (raw, kind, extra, hint) => {
    const c = parseCriterion(raw);
    expect(c).toEqual({ kind, ...extra });
    expect(hintFor(c, P, '7')).toBe(hint);
  });
  it('no hint repeats a raw criterion, except the pass-through kinds', () => {
    for (const [raw, kind, , hint] of CASES) if (hint && !['optional_when', 'required_when', 'invalid_when', 'criteria', 'pattern'].includes(kind)) expect(hint).not.toContain(raw);
  });
  it('does not pass vendor text after the colon of dropped-text kinds', () => {
    expect(hintFor(parseCriterion('ValidDefaultChannel: SECRET'), P, '1')).not.toContain('SECRET');
    expect(hintFor(parseCriterion('ExactCasingExpected: SECRET'), P, '1')).not.toContain('SECRET');
  });
});

describe('unknown and malformed', () => {
  it.each(['SomethingNew', '', 'required', 'ValidationCriteria:', 'ValidationCriteria', 'MinValue: abc', 'MaxValue: ', 'MaxCount: none', 'CanNotBeCombinedWith', 'HasDependencies: #1'])('%j is unknown', (raw) => {
    expect(parseCriterion(raw)).toEqual({ kind: 'unknown' });
  });
  it('unknown hint names the rule id and no vendor text', () => {
    expect(hintFor(parseCriterion('Weird: SECRET'), P, '42')).toBe(`${P} has a rule of a kind this server does not know (rule 42).`);
  });
  it('a head must match exactly', () => {
    expect(parseCriterion('RequiredX').kind).toBe('unknown');
    expect(parseCriterion('Required: tail').kind).toBe('required');
  });
});

describe('lists', () => {
  it('cap at 20 values plus a count', () => {
    const vals = Array.from({ length: 23 }, (_, i) => `v${i}`);
    const h = hintFor(parseCriterion(`ValidItems: ${vals.join(', ')}`), P, '1')!;
    expect(h).toBe(`${P} must be one of: ${vals.slice(0, 20).join(', ')}, … (3 more).`);
    expect(hintFor(parseCriterion(`ValidItems: ${vals.slice(0, 20).join(', ')}`), P, '1')).not.toContain('more');
  });
});

describe('HasDependencies', () => {
  it('parses operator and ids', () => {
    expect(parseCriterion('HasDependencies (AnyRequired): #12:Tag:Required:Field, #13:Tag:Required:Other')).toEqual({ kind: 'depends_on', operator: 'any', ids: ['12', '13'] });
    expect(parseCriterion('HasDependencies (AllRequired): #5:T:Required:F')).toEqual({ kind: 'depends_on', operator: 'all', ids: ['5'] });
    expect(parseCriterion('HasDependencies (AllRequired)')).toEqual({ kind: 'depends_on', operator: 'all', ids: [] });
  });
  it('hint resolves ids to paths, falls back to the rule id', () => {
    const c = parseCriterion('HasDependencies (AnyRequired): #12:T:Required:F, #99:T:Required:G');
    expect(hintFor(c, P, '1', new Map([['12', 'document.x']]))).toBe(`When ${P} is present, any one of these must be present: document.x, rule 99.`);
    expect(hintFor(parseCriterion('HasDependencies (AllRequired): #12'), P, '1')).toBe(`When ${P} is present, all of these must be present: rule 12.`);
  });
});

describe('criteriaOf / hintsFor', () => {
  it('adds the rule-level pattern only when the list has none', () => {
    expect(criteriaOf(rule({ expectedPattern: '^a$' }))).toEqual([{ kind: 'pattern', pattern: '^a$' }]);
    expect(criteriaOf(rule({ ruleCriterias: ['ExpectedPattern: ^b$'], expectedPattern: '^a$' }))).toEqual([{ kind: 'pattern', pattern: '^b$' }]);
    expect(criteriaOf(rule({ ruleCriterias: null, expectedPattern: '' }))).toEqual([]);
    expect(criteriaOf(rule())).toEqual([]);
  });
  it('dedups hints and drops kinds without one', () => {
    expect(hintsFor(rule({ ruleCriterias: ['Required', 'Required', 'ExampleValue: 1', 'NumericExpected'] }))).toEqual([`${P} is required.`, `${P} must contain digits only.`]);
  });
});

describe('flattenRules', () => {
  it('flattens children, keeps dependsOn, resolves paths', () => {
    const tree: RuleNode[] = [
      rule({ id: '1', parameter: 'Document.P', tag: 'EDI', isRequired: true, hasDependencies: true, dependencyOperator: 'AllRequired', ruleCriterias: ['HasDependencies (AllRequired): #2:EDI:Required:Q, #3:EDI:Required:R'], exampleValue: 'e',
        dependencies: [rule({ id: '2', parameter: 'Document.Q', ruleCriterias: ['Required'] }), rule({ id: '3', parameter: 'Document.R', dependencies: [rule({ id: '4', parameter: 'Document.S[].T' })] })] }),
    ];
    const out = flattenRules(tree);
    expect(out.map((r) => r.id)).toEqual(['1', '2', '3', '4']);
    expect(out[0]).toEqual({ id: '1', path: 'document.p', tag: 'EDI', required: true, example: 'e', hints: ['When document.p is present, all of these must be present: document.q, document.r.'], dependsOn: { operator: 'all', rules: [{ id: '2', path: 'document.q' }, { id: '3', path: 'document.r' }] } });
    expect(out[1]).toEqual({ id: '2', path: 'document.q', required: false, hints: ['document.q is required.'] });
    expect(out[3]!.path).toBe('document.s[].t');
    expect('dependsOn' in out[2]!).toBe(false); // child with no operator
  });
  it('any operator, pattern and omitted empty keys', () => {
    const [r] = flattenRules([rule({ dependencyOperator: 'AnyRequired', expectedPattern: '^x$', dependencies: [rule({ id: '8' })] })]);
    expect(r!.dependsOn!.operator).toBe('any');
    expect(r!.pattern).toBe('^x$');
    const [plain] = flattenRules([rule()]);
    expect(plain).toEqual({ id: '7', path: 'document.a.b', required: false, hints: [] });
  });
  it('an operator without children, or children without an operator, gives no dependsOn', () => {
    expect('dependsOn' in flattenRules([rule({ dependencyOperator: 'AllRequired' })])[0]!).toBe(false);
    expect('dependsOn' in flattenRules([rule({ dependencies: [rule({ id: '8' })] })])[0]!).toBe(false);
    expect('dependsOn' in flattenRules([rule({ dependencyOperator: 'Other', dependencies: [rule({ id: '8' })] })])[0]!).toBe(false);
  });
  it('required is strictly isRequired === true', () => {
    expect(flattenRules([rule({ isRequired: false })])[0]!.required).toBe(false);
  });
  it('an empty tree is empty', () => expect(flattenRules([])).toEqual([]));
});

describe('client rule schema', () => {
  it('parsed rules flow straight into flattenRules (types and runtime)', async () => {
    const { rulesResponseSchema } = await import('./operations.ts');
    const parsed = rulesResponseSchema.parse({ channel: 'X', rules: [{ id: '1', parameter: 'Document.A', isRequired: true, ruleCriterias: ['Required'], dependencies: [] }] });
    expect(flattenRules(parsed.rules)[0]).toMatchObject({ id: '1', path: 'document.a', required: true });
  });
});

describe('anchors and omitted keys (mutation)', () => {
  it('numbers must be whole-string numeric', () => {
    for (const raw of ['MinValue: 5x', 'MinValue: x5', 'MinValue: 1.', 'MinValue: 1.2.3']) expect(parseCriterion(raw)).toEqual({ kind: 'unknown' });
    expect(parseCriterion('MinValue: 12')).toEqual({ kind: 'min_value', n: '12' });
    expect(parseCriterion('MinValue: 1.25')).toEqual({ kind: 'min_value', n: '1.25' });
  });
  it('decimal bound is matched whole, not as a substring', () => {
    expect(hintFor({ kind: 'max_value', n: `1${BIG}` }, P, '1')).toBeDefined();
    expect(hintFor({ kind: 'max_value', n: `${BIG}1` }, P, '1')).toBeDefined();
    expect(hintFor({ kind: 'max_value', n: `${BIG}.5` }, P, '1')).toBeDefined();
    expect(hintFor({ kind: 'min_value', n: `-${BIG}` }, P, '1')).toBeUndefined();
  });
  it('MaxCount takes the trailing integer only', () => {
    expect(parseCriterion('MaxCount: Maximum 3 lines is 25')).toEqual({ kind: 'max_count', n: '25' });
    expect(parseCriterion('MaxCount: Maximum lines is 25.  ')).toEqual({ kind: 'max_count', n: '25' });
    expect(parseCriterion('MaxCount: Maximum lines is 25 x')).toEqual({ kind: 'unknown' });
    expect(parseCriterion('MaxCount: Maximum lines is 2.5.')).toEqual({ kind: 'max_count', n: '5' });
  });
  it('HasDependencies is anchored and the operator is exact', () => {
    expect(parseCriterion('x HasDependencies (AnyRequired): #1').kind).toBe('unknown');
    expect(parseCriterion('HasDependencies (AnyRequiredX): #1').kind).toBe('unknown');
    expect(parseCriterion('HasDependencies(AnyRequired): #1')).toMatchObject({ kind: 'depends_on', ids: ['1'] });
    expect(parseCriterion('  HasDependencies (AnyRequired) #1 ')).toMatchObject({ kind: 'depends_on', ids: ['1'] });
    expect(parseCriterion('HasDependencies (AnyRequired): #1,\n#2')).toMatchObject({ ids: ['1', '2'] });
    expect(parseCriterion('HasDependencies (AnyRequired):\n#1')).toMatchObject({ ids: ['1'] });
  });
  it('a head without a colon is the whole text; a leading colon is unknown', () => {
    expect(parseCriterion(':Required').kind).toBe('unknown');
    expect(parseCriterion('Required').kind).toBe('required');
    expect(parseCriterion('ExpectedPattern: a:b')).toEqual({ kind: 'pattern', pattern: 'a:b' });
  });
  it('rule note does not double the full stop but keeps a real ellipsis', () => {
    expect(hintFor({ kind: 'criteria', prose: 'a..' }, P, '1')).toBe('Rule note: a..');
    expect(hintFor({ kind: 'criteria', prose: 'a.' }, P, '1')).toBe('Rule note: a.');
  });
  it('optional keys are absent, not undefined', () => {
    expect(flattenRules([rule({ tag: '', exampleValue: '', expectedPattern: '' })])[0]).toStrictEqual({ id: '7', path: 'document.a.b', required: false, hints: [] });
  });
  it('a pattern criterion in the list wins over none and sets pattern once', () => {
    expect(flattenRules([rule({ ruleCriterias: ['Required'] })])[0]).not.toHaveProperty('pattern');
  });
});

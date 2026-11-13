// Synthetic documents and rules only (ADR 0004). The first path segment "document" names the document passed in.
import { describe, expect, it } from 'vitest';
import { localCheck } from './local-check.ts';
import { parseCriterion, type LocalRule } from './rules.ts';

const L = (id: string, path: string, raws: string[], tag?: string): LocalRule => ({ id, path, ...(tag ? { tag } : {}), criteria: raws.map(parseCriterion) });
const ABSENT = Symbol('absent');
const d = (v: unknown): unknown => (v === ABSENT ? { a: {} } : { a: { b: v } });
const P = 'document.a.b';
const TODAY = new Date('2026-11-13T15:00:00Z');

type Row = [name: string, raws: string[], kind: string, bad: unknown[], message: string, good: unknown[]];
const ROWS: Row[] = [
  ['required', ['Required'], 'required', [ABSENT, null, '', []], `${P} is required.`, ['x', 0, false]],
  ['array', ['ArrayExpected'], 'array', ['x', 5, {}], `${P} must be an array.`, [[], [1], ABSENT]],
  ['valid_items', ['ValidItems: a, b'], 'valid_items', ['c', 'ab'], `${P} must be one of: a, b.`, ['a', 'b', ABSENT]],
  ['valid_templates', ['ValidTemplates: 0, 2'], 'valid_templates', [5, '5'], `${P} must be one of the standard templates 0, 2.`, [2, '0', ABSENT]],
  ['pattern', ['ExpectedPattern: ^\\d{3}$'], 'pattern', ['12', 'abc', '1234'], `${P} must match the pattern ^\\d{3}$.`, ['123', ABSENT]],
  ['numeric', ['NumericExpected'], 'numeric', ['12a', '1.5', '-1'], `${P} must contain digits only.`, ['0123', 123, ABSENT]],
  ['decimal', ['DecimalExpected'], 'decimal', ['abc', '1,5'], `${P} must be a decimal number.`, ['1.5', '-2', 3.25, '10', ABSENT]],
  ['min_value', ['MinValue: 5'], 'min_value', [4, '4.99', '-1'], `${P} must be at least 5.`, [5, '5', '5.0', 6, ABSENT]],
  ['min_value beyond safe integers', ['MinValue: 9007199254740993'], 'min_value', ['9007199254740992'], `${P} must be at least 9007199254740993.`, ['9007199254740993', '9007199254740994']],
  ['max_value', ['MaxValue: 5'], 'max_value', [6, '5.01'], `${P} must be at most 5.`, [5, '4', ABSENT]],
  ['max_count', ['MaxCount: Maximum lines is 2.'], 'max_count', [[1, 2, 3]], `${P} may contain at most 2 items.`, [[1, 2], [], ABSENT]],
  ['unique', ['UniqueValueExpected'], 'unique', [[1, 2, 1], ['a', 'a']], `Values of ${P} must be unique within the array.`, [[1, 2], ['a', 'A'], [], ABSENT]],
  ['date_not_past', ['DateNotInPastExpected'], 'date_not_past', ['2026-11-12', '2026-11-12T23:59:59Z'], `${P} must not be a date in the past.`, ['2026-11-13', '2026-11-14T00:00:00Z', 'garbage', 12, ABSENT]],
];

describe('localCheck, one row per local kind, both directions', () => {
  describe.each(ROWS)('%s', (_n, raws, kind, bad, message, good) => {
    const rules = [L('9', P, raws)];
    it.each(bad.map((v) => [v === ABSENT ? '(absent)' : JSON.stringify(v), v] as const))('flags %s', (_l, v) => {
      expect(localCheck(d(v), rules, TODAY)).toEqual([{ source: 'local', ruleId: '9', path: P, kind, message, ...(kind === 'pattern' ? { expected: '^\\d{3}$' } : {}) }]);
    });
    it.each(good.map((v) => [v === ABSENT ? '(absent)' : JSON.stringify(v), v] as const))('passes %s', (_l, v) => {
      expect(localCheck(d(v), rules, TODAY)).toEqual([]);
    });
  });

  it('exclusive: flags when both this field and its sibling are present, not otherwise', () => {
    const rules = [L('9', P, ['CanNotBeCombinedWith: Other'])];
    expect(localCheck({ a: { b: 'x', other: 'y' } }, rules)).toEqual([{ source: 'local', ruleId: '9', path: P, kind: 'exclusive', message: `${P} cannot be set together with Other.` }]);
    expect(localCheck({ a: { b: 'x' } }, rules)).toEqual([]);
    expect(localCheck({ a: { other: 'y' } }, rules)).toEqual([]);
  });

  it('pattern finding carries expected and the rule example; tag is carried', () => {
    const f = localCheck({ a: { b: 'no' } }, [L('9', P, ['ExpectedPattern: ^\\d+$', 'ExampleValue: 42'], 'Template0')]);
    expect(f).toEqual([{ source: 'local', ruleId: '9', tag: 'Template0', path: P, kind: 'pattern', message: `${P} must match the pattern ^\\d+$.`, expected: '^\\d+$', example: '42' }]);
  });
});

describe('localCheck path resolution', () => {
  const line = [L('1', 'document.invoice.line[].id', ['Required'])];
  it('reports array elements with their index', () => {
    const f = localCheck({ invoice: { line: [{}, { id: 'x' }, {}] } }, line);
    expect(f.map((x) => [x.path, x.message])).toEqual([['document.invoice.line[0].id', 'document.invoice.line[0].id is required.'], ['document.invoice.line[2].id', 'document.invoice.line[2].id is required.']]);
  });
  it('nested arrays carry both indexes', () => {
    const f = localCheck({ a: [{ b: [{ c: 1 }] }, { b: [{}, { c: 1 }] }] }, [L('1', 'document.a[].b[].c', ['Required'])]);
    expect(f.map((x) => x.path)).toEqual(['document.a[1].b[0].c']);
  });
  it.each<[string, unknown]>([
    ['missing ancestor', {}], ['null ancestor', { invoice: null }], ['string ancestor', { invoice: 'x' }], ['missing array', { invoice: {} }],
    ['empty array', { invoice: { line: [] } }], ['array ancestor is not an array', { invoice: { line: { id: 1 } } }], ['non-object element', { invoice: { line: ['x', 3, null] } }],
  ])('skips the rule when %s (left to the dry run)', (_n, doc) => {
    expect(localCheck(doc, line)).toEqual([]);
  });
  it('a non-object document yields nothing', () => {
    for (const doc of [null, undefined, 'x', 5, []]) expect(localCheck(doc, line)).toEqual([]);
  });
  it('own-property access only: inherited names are absent, own __proto__ keys are real', () => {
    expect(localCheck({ a: {} }, [L('1', 'document.a.constructor', ['Required'])]).map((f) => f.path)).toEqual(['document.a.constructor']);
    expect(localCheck({ a: {} }, [L('1', 'document.a.__proto__', ['Required'])]).map((f) => f.path)).toEqual(['document.a.__proto__']);
    expect(localCheck({}, [L('1', 'document.constructor.name', ['Required'])])).toEqual([]);
    expect(localCheck({}, [L('1', 'document.__proto__.x', ['Required'])])).toEqual([]);
    const own = JSON.parse('{"__proto__":{"x":1},"constructor":{"name":"n"}}') as unknown;
    expect(localCheck(own, [L('1', 'document.__proto__.x', ['Required']), L('2', 'document.constructor.name', ['Required'])])).toEqual([]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('localCheck certainty (never a false invalid)', () => {
  it('OptionalWhen on the same path suppresses required, as a second rule or in the same rule', () => {
    expect(localCheck({ a: {} }, [L('1', P, ['Required']), L('2', P, ['OptionalWhen: Foo = 1'])])).toEqual([]);
    expect(localCheck({ a: {} }, [L('1', P, ['Required', 'OptionalWhen: Foo = 1'])])).toEqual([]);
    expect(localCheck({ a: {} }, [L('1', P, ['Required']), L('2', 'document.a.c', ['OptionalWhen: Foo = 1'])]).map((f) => f.kind)).toEqual(['required']);
  });
  it('OptionalWhen does not suppress other kinds', () => {
    expect(localCheck({ a: { b: 'x' } }, [L('1', P, ['NumericExpected']), L('2', P, ['OptionalWhen: Foo = 1'])]).map((f) => f.kind)).toEqual(['numeric']);
  });
  it('skips unparseable regex, too long patterns, and unknown or dry-run-only kinds', () => {
    const doc = { a: { b: 'zzz' } };
    expect(localCheck(doc, [L('1', P, ['ExpectedPattern: ('])])).toEqual([]);
    expect(localCheck(doc, [L('1', P, [`ExpectedPattern: ^${'a'.repeat(499)}$`])])).toEqual([]); // 501 chars
    expect(localCheck({ a: { b: 'b' } }, [L('1', P, [`ExpectedPattern: ^${'a'.repeat(498)}$`])]).map((f) => f.kind)).toEqual(['pattern']); // 500 chars still checked
    expect(localCheck(doc, [L('1', P, ['Frobnicate', 'ValidChannels: A', 'ValidDefaultChannel: A', 'StartDateNotPastEndDateExpected', 'ExactCasingExpected', 'FileNameExpected',
      'RequiredWhen: x = 1', 'InvalidWhen: x = 1', 'ValidationCriteria: note', 'ArrayWithValidItemsExpected', 'HasDependencies (AnyRequired): #2'])])).toEqual([]);
  });
  it('an unknown kind does not hide a known one in the same rule', () => {
    expect(localCheck({ a: {} }, [L('1', P, ['Frobnicate', 'Required'])]).map((f) => f.kind)).toEqual(['required']);
  });
  it('does not test strings over 10000 characters against a pattern', () => {
    const rules = [L('1', P, ['ExpectedPattern: ^a*$'])];
    expect(localCheck({ a: { b: 'b'.repeat(10_000) } }, rules)).toHaveLength(1);
    expect(localCheck({ a: { b: 'b'.repeat(10_001) } }, rules)).toEqual([]);
  });
  it('unparseable numbers and non-scalar values are skipped for numeric kinds', () => {
    for (const v of [{}, [1], true, null, 'abc']) expect(localCheck({ a: { b: v } }, [L('1', P, ['MinValue: 5', 'MaxValue: 3'])])).toEqual([]);
  });
});

describe('children of an AnyRequired group', () => {
  const B = { ...L('2', 'document.a.b', ['Required', 'NumericExpected']), anyGroup: true as const };
  const C = { ...L('3', 'document.a.c', ['Required']), anyGroup: true as const };
  it('skip only the required check: parent and B present, C missing -> nothing', () => {
    expect(localCheck({ a: { p: 1, b: '1' } }, [L('1', 'document.a.p', ['Required']), B, C])).toEqual([]);
  });
  it('other criteria still run', () => {
    expect(localCheck({ a: { b: 'x' } }, [B]).map((f) => f.kind)).toEqual(['numeric']);
  });
  it('AllRequired children (no mark) keep the required check', () => {
    expect(localCheck({ a: {} }, [L('3', 'document.a.c', ['Required'])]).map((f) => f.kind)).toEqual(['required']);
  });
});

describe('localCheck output shape', () => {
  it('dedups the same rule listed twice (two channels), keeps different rules', () => {
    const r = L('1', P, ['Required']);
    expect(localCheck({ a: {} }, [r, { ...r }, L('2', P, ['Required'])]).map((f) => f.ruleId)).toEqual(['1', '2']);
  });
  it('sorts by path, then rule id', () => {
    const rules = [L('b', 'document.a.z', ['Required']), L('b', 'document.a.c', ['Required']), L('a', 'document.a.z', ['Required']), L('a', 'document.a.c', ['Required'])];
    expect(localCheck({ a: {} }, rules).map((f) => `${f.path}|${f.ruleId}`)).toEqual(['document.a.c|a', 'document.a.c|b', 'document.a.z|a', 'document.a.z|b']);
  });
  it('does not mutate the document or the rules', () => {
    const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
    const doc = deepFreeze({ a: { b: ['x', 'x'], l: [{}, { id: 1 }] } });
    const rules = deepFreeze([L('1', P, ['UniqueValueExpected']), L('2', 'document.a.l[].id', ['Required'])]);
    const before = JSON.stringify(doc);
    expect(localCheck(doc, rules)).toHaveLength(2);
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('stops collecting after 200 findings on a 100k element array', () => {
    const line = Array.from({ length: 300 }, (_, i) => (i >= 200 ? { get id(): never { throw new Error('read past 201st element'); } } : {}));
    const doc = { invoice: { line } };
    const f = localCheck(doc, [L('1', 'document.invoice.line[].id', ['Required'])]);
    expect(f).toHaveLength(200);
    expect(f[0]!.path).toBe('document.invoice.line[0].id');
  });
  it('defaults today to the current date', () => {
    const rules = [L('1', P, ['DateNotInPastExpected'])];
    expect(localCheck({ a: { b: '2000-01-01' } }, rules)).toHaveLength(1);
    expect(localCheck({ a: { b: '2999-01-01' } }, rules)).toEqual([]);
  });
});

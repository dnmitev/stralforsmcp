// Mutation-killing cases for local-check. Synthetic documents and rules only (ADR 0004).
import { describe, expect, it } from 'vitest';
import { localCheck } from './local-check.ts';
import { parseCriterion, type LocalRule } from './rules.ts';

const L = (id: string, path: string, raws: string[]): LocalRule => ({ id, path, criteria: raws.map(parseCriterion) });
const P = 'document.a.b';
const TODAY = new Date('2026-11-13T15:00:00Z');
const kinds = (v: unknown, raws: string[], doc: unknown = { a: { b: v } }) => localCheck(doc, [L('9', P, raws)], TODAY).map((f) => f.kind);

describe('decimal grammar', () => {
  it.each(['1', '12', '1.', '1.5', '.5', '.55', '1e5', '1E+5', '1e-5', '1e55', '12e10', '+1.5', '-.5'])('accepts %s', (v) => expect(kinds(v, ['DecimalExpected'])).toEqual([]));
  it.each(['.', 'e5', '1e', '1e+', '1.5.5', '1 ', ' 1', 'a1', '1a', '.5a', '1e5x'])('flags %s', (v) => expect(kinds(v, ['DecimalExpected'])).toEqual(['decimal']));
  it('does not flag a boolean', () => expect(kinds(true, ['DecimalExpected'])).toEqual([]));
});

describe('min/max value, exact decimal comparison', () => {
  it.each<[string, string, unknown, boolean]>([
    ['MinValue', '-5', '-7', true], ['MinValue', '-5', '-3', false], ['MinValue', '-5', -3, false], ['MinValue', '-5', '-5', false],
    ['MinValue', '0', '-0', false], ['MinValue', '0', '-0.0', false], ['MinValue', '0', '-0.5', true], ['MinValue', '0', '-5', true],
    ['MinValue', '100', '99', true], ['MinValue', '100', '100', false], ['MinValue', '100', '1000', false],
    ['MinValue', '1.5', '1.25', true], ['MinValue', '1.5', '1.50', false], ['MinValue', '1.5', '1.05', true], ['MinValue', '1.5', '1.6', false],
    ['MinValue', '5', '007', false], ['MinValue', '5', '0004', true],
    ['MaxValue', '0', '-0.00', false], ['MaxValue', '0', '-1', false], ['MaxValue', '-5', '-7', false], ['MaxValue', '-5', '-3', true], ['MaxValue', '-5', '3', true],
    ['MaxValue', '5', '5.0', false], ['MaxValue', '5', '5.01', true], ['MaxValue', '5', '10', true], ['MaxValue', '10', '9', false],
    ['MaxValue', '0', 'x1', false], ['MaxValue', '0', '1x', false], ['MinValue', '5', 'x1', false], ['MinValue', '5', '1x', false], ['MaxValue', '0', '-', false],
    ['MaxValue', '1.5', '1.500', false], ['MaxValue', '1.5', '1.5001', true], ['MaxValue', '0', true, false], ['MinValue', '5', {}, false],
  ])('%s %s with %j flagged=%s', (k, n, v, flagged) => expect(kinds(v, [`${k}: ${n}`])).toEqual(flagged ? [k === 'MinValue' ? 'min_value' : 'max_value'] : []));
  it('a bound with no hint (decimal limit) never produces a finding', () => {
    expect(kinds('-79228162514264337593543950336', ['MinValue: -79228162514264337593543950335'])).toEqual([]);
    expect(kinds('79228162514264337593543950336', ['MaxValue: 79228162514264337593543950335'])).toEqual([]);
  });
});

describe('required, array, list, pattern, numeric', () => {
  it('required: a non-empty array, zero and false are present', () => {
    expect(kinds([1], ['Required'])).toEqual([]);
    expect(kinds('x', ['Required'])).toEqual([]);
  });
  it('array: null is left alone, an object is not an array', () => {
    expect(kinds(null, ['ArrayExpected'])).toEqual([]);
    expect(kinds({}, ['ArrayExpected'])).toEqual(['array']);
  });
  it.each([{}, true, ['z'], [1]])('valid_items ignores non-scalar %j', (v) => {
    expect(kinds(v, ['ValidItems: a, b'])).toEqual([]);
    expect(kinds(v, ['ValidTemplates: 1, 2'])).toEqual([]);
  });
  it('pattern ignores a non-string and an oversize text or pattern', () => {
    expect(kinds(5, ['ExpectedPattern: ^\\d{3}$'])).toEqual([]);
    expect(kinds('x'.repeat(10_001), ['ExpectedPattern: ^y$'])).toEqual([]);
    expect(kinds('x', [`ExpectedPattern: ^${'y'.repeat(500)}$`])).toEqual([]);
    expect(kinds('x'.repeat(10_000), ['ExpectedPattern: ^y$'])).toEqual(['pattern']);
    expect(kinds('x', [`ExpectedPattern: ^${'y'.repeat(497)}$`])).toEqual(['pattern']);
    expect(kinds('x', ['ExpectedPattern: ([unclosed'])).toEqual([]);
  });
  it.each([[-1, true], [1.5, true], [0, false], [7, false], [true, false], ['12', false], ['', true], ['1 ', true]])('numeric %j flagged=%s', (v, flagged) => expect(kinds(v, ['NumericExpected'])).toEqual(flagged ? ['numeric'] : []));
});

describe('unique', () => {
  it.each<[unknown, boolean]>([['x', false], [{}, false], [[null, null], true], [[{ a: 1 }, { a: 1 }], false], [[{ a: 1 }, 1, 1], false], [[1, '1'], false], [[1, 1], true], [[true, true], true]])('%j flagged=%s', (v, f) => expect(kinds(v, ['UniqueValueExpected'])).toEqual(f ? ['unique'] : []));
});

describe('date_not_past', () => {
  it.each<[unknown, boolean]>([[['2026-11-12'], false], [' 2020-01-01', false], ['2020-01-01 10:00', false], ['2020-01-01x', false], ['2026-11-12', true], ['2026-11-13', false],
    ['2026-11-12T23:00:00-05:00', false], ['2026-11-13T02:00:00+05:00', true], ['2026-11-14T00:00:00Z', false]])('%j flagged=%s', (v, f) => expect(kinds(v, ['DateNotInPastExpected'])).toEqual(f ? ['date_not_past'] : []));
});

describe('exclusive and structure', () => {
  const rules = [L('9', P, ['CanNotBeCombinedWith: Other'])];
  it('null on either side is not "set"', () => {
    expect(localCheck({ a: { b: null, other: 'y' } }, rules)).toEqual([]);
    expect(localCheck({ a: { b: 'x', other: null } }, rules)).toEqual([]);
    expect(localCheck({ a: { b: 'x', other: 'y' } }, rules)).toHaveLength(1);
  });
  it('a rule on the document root alone is ignored', () => {
    expect(localCheck({}, [L('1', 'document', ['Required'])])).toEqual([]);
  });
  it('an array-like object is not walked as an array', () => {
    expect(localCheck({ a: { b: { length: 1, 0: { c: '' } } } }, [L('1', 'document.a.b[].c', ['Required'])])).toEqual([]);
    expect(localCheck({ a: { b: [{ c: '' }] } }, [L('1', 'document.a.b[].c', ['Required'])]).map((f) => f.path)).toEqual(['document.a.b[0].c']);
  });
  it('findings are capped at 200 exactly', () => {
    const doc = { a: { b: Array.from({ length: 250 }, () => ({})) } };
    expect(localCheck(doc, [L('1', 'document.a.b[].c', ['Required'])])).toHaveLength(200);
    expect(localCheck({ a: { b: Array.from({ length: 200 }, () => ({})) } }, [L('1', 'document.a.b[].c', ['Required'])])).toHaveLength(200);
    expect(localCheck({ a: { b: Array.from({ length: 199 }, () => ({})) } }, [L('1', 'document.a.b[].c', ['Required'])])).toHaveLength(199);
  });
  it('the 200 cap holds across many rules, one finding each', () => {
    const rules = Array.from({ length: 201 }, (_, i) => L(String(i + 1), `document.a.f${String(i).padStart(3, '0')}`, ['Required']));
    expect(localCheck({ a: {} }, rules)).toHaveLength(200);
    expect(localCheck({ a: {} }, rules.slice(0, 200))).toHaveLength(200);
    expect(localCheck({ a: {} }, rules.slice(0, 199))).toHaveLength(199);
  });
  it('non-pattern findings carry no expected or example key', () => {
    const [f] = localCheck({ a: {} }, [L('1', P, ['Required', 'ExampleValue: 5'])]);
    expect(Object.keys(f!).sort()).toEqual(['kind', 'message', 'path', 'ruleId', 'source']);
  });
  it('sorts by path then rule id', () => {
    const f = localCheck({ a: {} }, [L('2', 'document.a.z', ['Required']), L('10', 'document.a.b', ['Required']), L('1', 'document.a.b', ['Required'])]);
    expect(f.map((x) => `${x.path}#${x.ruleId}`)).toEqual(['document.a.b#1', 'document.a.b#10', 'document.a.z#2']);
  });
});

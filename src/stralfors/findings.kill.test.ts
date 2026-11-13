// Mutation-killing cases for findings. Synthetic violations only (ADR 0004).
import { describe, expect, it } from 'vitest';
import { fromBadRequest, fromViolations } from './findings.ts';
import { hintFor } from './rules.ts';
import type { Violation } from './errors.ts';

const v = (over: Partial<Violation> = {}): Violation => ({ ruleId: '3', path: 'Document.A.B', criteria: ['Required'], ...over });

describe('ids and tags are validated before they are echoed', () => {
  it.each(['x3', '3x', '', '3 ', 'a'])('ruleId %j is dropped', (id) => {
    const [f] = fromViolations([v({ ruleId: id })]);
    expect(f).not.toHaveProperty('ruleId');
    expect(f!.message).toBe('document.a.b is required.');
  });
  it('ruleId undefined stays out and an unknown rule is named "unknown"', () => {
    const [f] = fromViolations([v({ ruleId: undefined, criteria: [] })]);
    expect(f).not.toHaveProperty('ruleId');
    expect(f!.message).toBe(hintFor({ kind: 'unknown' }, 'document.a.b', 'unknown'));
    expect(f!.message).toContain('rule unknown');
  });
  it.each([undefined, '', 'bad tag', 'x-y', 'Template0x!', 'Tag\n'])('tag %j is dropped', (tag) => expect(fromViolations([v({ tag })])[0]).not.toHaveProperty('tag'));
  it.each(['Template0', 'a_b', 'X'])('tag %s is kept', (tag) => expect(fromViolations([v({ tag })])[0]).toMatchObject({ tag }));
  it('a tag that fails the pattern at the start or the end is dropped', () => {
    expect(fromViolations([v({ tag: '!Template' })])[0]).not.toHaveProperty('tag');
    expect(fromViolations([v({ tag: 'Template!' })])[0]).not.toHaveProperty('tag');
  });
});

describe('server errors', () => {
  it('name the rule only when the id is valid', () => {
    expect(fromViolations([v({ serverError: true, ruleId: '12' })])[0]!.message).toMatch(/ Report rule 12 to Stralfors\.$/);
    const [f] = fromViolations([v({ serverError: true, ruleId: undefined })]);
    expect(f!.message).toBe("Stralfors' rule engine failed on this rule; this is not a problem with the document.");
    expect(f).toMatchObject({ kind: 'rule_engine', serverError: true });
  });
});

describe('unusable paths', () => {
  it.each(['Doc ument', 'a-b', 'a\n', ''])('path %j: unknown finding with an empty path and the generic field wording', (path) => {
    const [f] = fromViolations([v({ path, criteria: ['Required'] })]);
    expect(f).toMatchObject({ kind: 'unknown', path: '' });
    expect(f!.message).toBe(hintFor({ kind: 'unknown' }, 'A document field', '3'));
    expect(f!.message).toContain('A document field');
  });
  it('a path rejected by the pattern at the start or end is not echoed', () => {
    expect(fromViolations([v({ path: '!Doc.A' })])[0]!.path).toBe('');
    expect(fromViolations([v({ path: 'Doc.A!' })])[0]!.path).toBe('');
  });
});

describe('criteria', () => {
  it('one finding per kind; a repeated kind is dropped, a different kind kept', () => {
    const f = fromViolations([v({ criteria: ['Required', 'Required', 'NumericExpected', 'NumericExpected'] })]);
    expect(f.map((x) => x.kind)).toEqual(['required', 'numeric']);
  });
  it('expected only for pattern; example only when the rule has one', () => {
    const [a, b] = fromViolations([v({ criteria: ['Required', 'ExpectedPattern: ^x$'] })]);
    expect(a).not.toHaveProperty('expected');
    expect(a).not.toHaveProperty('example');
    expect(b).toMatchObject({ expected: '^x$' });
    expect(b).not.toHaveProperty('example');
    const [c, d] = fromViolations([v({ criteria: ['Required', 'ExpectedPattern: ^x$', 'ExampleValue: x'] })]);
    expect(c).toMatchObject({ example: 'x' });
    expect(d).toMatchObject({ expected: '^x$', example: 'x' });
  });
  it('an unknown criterion is reported as unknown, naming the rule', () => {
    const [f] = fromViolations([v({ criteria: ['Mystery'] })]);
    expect(f!.kind).toBe('unknown');
    expect(f!.message).toBe(hintFor({ kind: 'unknown' }, 'document.a.b', '3'));
  });
  it('criteria without a usable id: the message names rule "unknown"', () => {
    const [f] = fromViolations([v({ ruleId: undefined, criteria: ['Mystery'] })]);
    expect(f!.message).toContain('rule unknown');
  });
  it('a criterion hint is created with the id, not a fixed word', () => {
    const [f] = fromViolations([v({ ruleId: '77', criteria: ['Mystery'] })]);
    expect(f!.message).toContain('rule 77');
  });
});

describe('fromBadRequest', () => {
  it('a usable key becomes a path finding; an unusable one the generic wording', () => {
    expect(fromBadRequest({ 'Document.Invoice.IssueDate': ['x'] })).toEqual([{ source: 'stralfors', path: 'document.invoice.issueDate', kind: 'shape', message: 'document.invoice.issueDate is not accepted by Stralfors; compare it with get_example_invoice.' }]);
    expect(fromBadRequest({ 'bad key!': ['x'] })).toEqual([{ source: 'stralfors', path: '', kind: 'shape', message: 'A field is not accepted by Stralfors; compare the document with get_example_invoice.' }]);
    expect(fromBadRequest({ '!a': [] })[0]!.path).toBe('');
    expect(fromBadRequest({ 'a!': [] })[0]!.path).toBe('');
  });
});

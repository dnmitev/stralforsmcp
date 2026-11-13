// Synthetic violations only (ADR 0004). Findings are fixed templates; no upstream text may survive.
import { describe, expect, it } from 'vitest';
import { fromBadRequest, fromFields, fromViolations, type Finding } from './findings.ts';
import { hintFor } from './rules.ts';
import type { Violation } from './errors.ts';

const SENTENCE = (id: string): string => `Stralfors' rule engine failed on this rule; this is not a problem with the document. Report rule ${id} to Stralfors.`;
const v = (over: Partial<Violation> = {}): Violation => ({ ruleId: '3', path: 'Document.DocumentHeader.ChannelPriority', criteria: [], ...over });

describe('fromViolations', () => {
  it('maps list criteria to one finding each, attaches the example, camelCases the path', () => {
    const f = fromViolations([v({ criteria: ['ValidChannels: A, B', 'ValidDefaultChannel: A', 'ExampleValue: A'] })]);
    expect(f.map((x) => x.kind)).toEqual(['valid_channels', 'default_channel']);
    expect(f[0]).toMatchObject({ source: 'stralfors', ruleId: '3', path: 'document.documentHeader.channelPriority', example: 'A' });
    expect(f[0]!.message).toContain('A, B');
    expect(f[1]!.message).toBe(hintFor({ kind: 'default_channel' }, '', '3'));
  });
  it('attaches expected only for pattern, and the tag when present', () => {
    const [f] = fromViolations([v({ tag: 'Template0', path: 'Document.Invoice.AdditionalDocumentReference[].Id.Value', criteria: ['ExpectedPattern: ^x$'] })]);
    expect(f).toEqual({ source: 'stralfors', ruleId: '3', tag: 'Template0', path: 'document.invoice.additionalDocumentReference[].id.value', kind: 'pattern', message: 'document.invoice.additionalDocumentReference[].id.value must match the pattern ^x$.', expected: '^x$' });
    const [g] = fromViolations([v({ criteria: ['Required'] })]);
    expect(g).toEqual({ source: 'stralfors', ruleId: '3', path: 'document.documentHeader.channelPriority', kind: 'required', message: 'document.documentHeader.channelPriority is required.' });
  });
  it('drops optional; empty or only-dropped criteria give kind unknown with the fixed sentence', () => {
    for (const criteria of [[], ['Optional']]) {
      const f = fromViolations([v({ criteria })]);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ kind: 'unknown', ruleId: '3' });
      expect(f[0]!.message).toBe(hintFor({ kind: 'unknown' }, 'document.documentHeader.channelPriority', '3'));
    }
  });
  it('serverError gives one rule_engine finding with the fixed sentence and none of the exception text', () => {
    const f = fromViolations([v({ serverError: true, criteria: ['NullReferenceException at Foo.Bar() stack trace', 'Required'] })]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ source: 'stralfors', kind: 'rule_engine', serverError: true, ruleId: '3', message: SENTENCE('3') });
    expect(JSON.stringify(f)).not.toMatch(/NullReference|stack trace|Foo/);
  });
  it('names the rule only when its id is digits', () => {
    expect(fromViolations([v({ serverError: true, ruleId: '12' })])[0]!.message).toBe(SENTENCE('12'));
    for (const ruleId of ['x y', undefined]) {
      const m = fromViolations([v({ serverError: true, ruleId: ruleId as string })])[0]!.message;
      expect(m).toContain('rule engine failed');
      expect(m).not.toContain('Report rule');
      expect(m).not.toContain('x y');
    }
  });
  it('a path outside the grammar becomes "" with kind unknown and no free text', () => {
    const f = fromViolations([v({ path: 'Something went wrong near the invoice', criteria: ['Required'] })]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ path: '', kind: 'unknown' });
    expect(JSON.stringify(f)).not.toContain('Something');
  });
  it('unknown criteria give kind unknown, not the vendor text', () => {
    const f = fromViolations([v({ criteria: ['Frobnicate the widget'] })]);
    expect(f.map((x) => x.kind)).toEqual(['unknown']);
    expect(JSON.stringify(f)).not.toContain('widget');
  });
  it('maps several violations in order and handles none', () => {
    expect(fromViolations([])).toEqual([]);
    expect(fromViolations([v({ ruleId: '1', criteria: ['Required'] }), v({ ruleId: '2', criteria: ['NumericExpected'] })]).map((x) => [x.ruleId, x.kind])).toEqual([['1', 'required'], ['2', 'numeric']]);
  });
});

describe('fromBadRequest', () => {
  it('one shape finding per key with the fixed message; values dropped', () => {
    const f: Finding[] = fromBadRequest({ 'document.invoice.issueDate': ['any text'], 'Document.Invoice.Total': ['more', 'text'] });
    expect(f).toEqual([
      { source: 'stralfors', path: 'document.invoice.issueDate', kind: 'shape', message: 'document.invoice.issueDate is not accepted by Stralfors; compare it with get_example_invoice.' },
      { source: 'stralfors', path: 'document.invoice.total', kind: 'shape', message: 'document.invoice.total is not accepted by Stralfors; compare it with get_example_invoice.' },
    ]);
  });
  it('a key outside the path grammar never reaches the output', () => {
    const out = JSON.stringify(fromBadRequest({ 'Value 42 could not be converted': ['secret words'] }));
    expect(out).not.toMatch(/converted|secret/);
  });
  it('no errors, no findings', () => expect(fromBadRequest({})).toEqual([]));
});

describe('fromFields', () => {
  it('one shape finding per field', () => {
    expect(fromFields(['document.invoice', 'document.documentHeader'])).toEqual([
      { source: 'local', path: 'document.invoice', kind: 'shape', message: 'document.invoice is missing or has the wrong type.' },
      { source: 'local', path: 'document.documentHeader', kind: 'shape', message: 'document.documentHeader is missing or has the wrong type.' },
    ]);
    expect(fromFields([])).toEqual([]);
  });
});

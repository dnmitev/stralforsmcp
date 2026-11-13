/* Tool metadata and schemas pinned exactly (mutation targets): names, titles, descriptions, notes, strict output shapes. */
import { describe, expect, it } from 'vitest';
import { AGREEMENT_REQUIRED } from './channels.ts';
import { createRulesCache } from './rules-cache.ts';
import { EXAMPLE_NOTES, MAX_LIMIT, DEFAULT_LIMIT, createGetExampleInvoice, createGetRules, getExampleInput, getRulesInput, getRulesOutput } from './rules-tools.ts';

const rules = createGetRules({ clients: new Map(), cache: createRulesCache({ ttlMs: 0 }) });
const example = createGetExampleInvoice({ clients: new Map() });

describe('metadata', () => {
  it('get_rules', () => {
    expect(rules.spec).toEqual({ name: 'get_rules', access: 'read' });
    expect(rules.title).toBe('Get rules');
    expect(rules.description).toContain('validation rules of one delivery channel');
    expect(rules.description).toContain(`limit up to ${MAX_LIMIT}`);
    expect(rules.description).toContain('hasMore');
    expect(rules.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect([DEFAULT_LIMIT, MAX_LIMIT]).toEqual([100, 200]);
  });
  it('get_example_invoice', () => {
    expect(example.spec).toEqual({ name: 'get_example_invoice', access: 'read' });
    expect(example.title).toBe('Get example invoice');
    expect(example.description).toContain('without the agreement id');
    expect(example.description).toContain('not valid data');
    expect(example.annotations).toEqual(rules.annotations);
  });
  it('notes, exactly', () => {
    expect(EXAMPLE_NOTES).toEqual([
      'Leaf values are patterns or placeholders, not valid data; replace every one before validating.',
      'The agreement is chosen by its label when validating or sending; the example never carries an agreement id.',
      'consignmentId must be 10-50 characters and unique per agreement: duplicates are refused for 35 days in production and 7 days in test.',
      'documentHeader.sTT.externalDocId is the reference that tracking lookups can later be searched by.',
    ]);
  });
  it('AGREEMENT_REQUIRED', () => expect(AGREEMENT_REQUIRED).toBe('agreement is required'));
});

describe('schemas', () => {
  it('profile names are not limited to one character', () => {
    expect(getRulesInput.safeParse({ channel: 'X', profile: 'long-profile-name' }).success).toBe(true);
    expect(getExampleInput.safeParse({ channels: ['X'], profile: 'long-profile-name' }).success).toBe(true);
    expect(getRulesInput.safeParse({ channel: 'X', profile: '' }).success).toBe(false);
    expect(getExampleInput.safeParse({ channels: ['X'], profile: '' }).success).toBe(false);
  });
  const rule = { id: '1', path: 'a.b', required: true, hints: [] };
  const out = (r: unknown) => getRulesOutput.safeParse({ profile: 'a', channel: 'X', templateStandardId: 0, total: 1, offset: 0, returned: 1, hasMore: false, rules: [r] }).success;
  it('the rule shape is strict: no raw vendor keys, dependsOn well formed', () => {
    expect(out(rule)).toBe(true);
    expect(out({ ...rule, parameter: 'Raw' })).toBe(false);
    expect(out({ ...rule, dependsOn: { operator: 'all', rules: [{ id: '2', path: 'a.c' }] } })).toBe(true);
    expect(out({ ...rule, dependsOn: { operator: 'some', rules: [] } })).toBe(false);
    expect(out({ ...rule, dependsOn: { operator: 'any', rules: [{ id: '2', path: 'a.c', extra: 1 }] } })).toBe(false);
    expect(out({ ...rule, dependsOn: { operator: 'any', rules: [{ id: '2' }] } })).toBe(false);
    expect(out({ ...rule, dependsOn: { operator: 'any' } })).toBe(false);
    expect(out({ ...rule, dependsOn: { rules: [] } })).toBe(false);
    expect(out({ ...rule, dependsOn: { operator: 'any', rules: [], extra: 1 } })).toBe(false);
  });
});

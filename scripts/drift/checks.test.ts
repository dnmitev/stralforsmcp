import { describe, expect, it } from 'vitest';
import type { RuleNode } from '../../src/stralfors/rules.ts';
import { badPatterns, channelDiff, criteriaHashes, hashDiff, templateShape, unknownKinds, versionDiff } from './checks.ts';

const rule = (id: string, extra: Partial<RuleNode> = {}): RuleNode => ({ id, parameter: `Document.Field${id}`, ...extra });
const known: RuleNode[] = [rule('1', { ruleCriterias: ['Required', 'NumericExpected'] })];

describe('unknownKinds', () => {
  it('no drift: every kind parses', () => expect(unknownKinds(known)).toEqual([]));
  it('counts criteria the parser does not know, nested ones included', () => {
    const tree = [rule('1', { ruleCriterias: ['Required', 'BrandNewThing: x'], dependencies: [rule('2', { ruleCriterias: ['AnotherNewThing'] })] })];
    expect(unknownKinds(tree)).toEqual([{ check: 'unknown-criterion', count: 2 }]);
  });
});

describe('channelDiff', () => {
  it('skipped without expectations', () => expect(channelDiff(['A'], undefined)).toEqual([]));
  it('no drift when equal, order ignored', () => expect(channelDiff(['B', 'A'], ['A', 'B'])).toEqual([]));
  it('new and missing channels', () => expect(channelDiff(['A', 'N1', 'N2'], ['A', 'M'])).toEqual([{ check: 'channel-new', count: 2 }, { check: 'channel-missing', count: 1 }]));
});

describe('versionDiff', () => {
  it('skipped without expectation', () => expect(versionDiff('2.0', undefined)).toEqual([]));
  it('equal is fine', () => expect(versionDiff('2.0', '2.0')).toEqual([]));
  it('different or absent version is drift', () => {
    expect(versionDiff('2.1', '2.0')).toEqual([{ check: 'api-version', count: 1 }]);
    expect(versionDiff(undefined, '2.0')).toEqual([{ check: 'api-version', count: 1 }]);
  });
});

describe('badPatterns', () => {
  it('compilable patterns pass', () => expect(badPatterns([rule('1', { expectedPattern: '^[0-9]+$' })])).toEqual([]));
  it('counts patterns JS cannot compile, per rule', () => {
    const tree = [rule('1', { expectedPattern: '(?<n' }), rule('2', { expectedPattern: '([' }), rule('3', { expectedPattern: 'ok' })];
    expect(badPatterns(tree)).toEqual([{ check: 'pattern-not-compilable', count: 2 }]);
  });
});

describe('criteria hashes', () => {
  const withProse = (prose: string) => [rule('1', { ruleCriterias: [`ValidationCriteria: ${prose}`, 'RequiredWhen: a == 1'] })];
  it('same text gives same hashes, order-independent, 64 hex chars', () => {
    const h = criteriaHashes(withProse('one'));
    expect(h.length).toBeGreaterThan(0);
    expect(h.every((x) => /^[0-9a-f]{64}$/.test(x))).toBe(true);
    expect(hashDiff(criteriaHashes(withProse('one')), h)).toEqual([]);
  });
  it('changed prose is drift, counted both directions', () => {
    const out = hashDiff(criteriaHashes(withProse('two')), criteriaHashes(withProse('one')));
    expect(out).toEqual([{ check: 'criteria-changed', count: 2 }]);
  });
  it('findings and hashes never carry the observed text', () => {
    const canary = 'CANARY-prose-abc123';
    const tree = withProse(canary);
    const dump = JSON.stringify([criteriaHashes(tree), hashDiff(criteriaHashes(tree), []), unknownKinds(tree), badPatterns([rule('9', { expectedPattern: `(${canary}` })])]);
    expect(dump).not.toContain(canary);
  });
});

describe('templateShape', () => {
  it('no drift when every entry has a type name', () => expect(templateShape([{ standardId: 1, type: { name: 'a' } }])).toEqual([]));
  it('counts entries without a type name', () => expect(templateShape([{ standardId: 1 }, { standardId: 2, type: { name: 'x' } }, { standardId: 3, type: { name: '' } }])).toEqual([{ check: 'template-shape', count: 2 }]));
});

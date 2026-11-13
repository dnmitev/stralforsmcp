/* loadRules(cache, client, profile, channel, templateStandardId): one shared cached { readable, local } per (profile, channel, template). */
import { describe, expect, it, vi } from 'vitest';
import { flattenRulesWithCriteria } from '../stralfors/rules.ts';
import { createRulesCache } from './rules-cache.ts';
import { loadRules } from './rules-load.ts';

const tree = [
  { id: '1', parameter: 'Document.Invoice.A', isRequired: true, ruleCriterias: ['Required', 'ExpectedPattern: ^x$'], dependencies: [] },
  { id: '2', tag: 'Template0', parameter: 'Document.Invoice.Line[].B', isRequired: false, ruleCriterias: ['NumericExpected'], dependencies: [] },
];
const client = () => ({ rules: vi.fn(async (_c: string, _o: { templateStandardId?: number }) => ({ channel: 'X', rules: tree })) });

describe('loadRules', () => {
  it('returns readable and local from one tree walk', async () => {
    const c = client();
    const r = await loadRules(createRulesCache({ ttlMs: 1000 }), c as never, 'a', 'X', 3);
    expect(r).toEqual(flattenRulesWithCriteria(tree));
    expect(r.readable.map((x) => x.path)).toEqual(['document.invoice.a', 'document.invoice.line[].b']);
    expect(r.local.map((x) => [x.id, x.path, x.tag])).toEqual([['1', 'document.invoice.a', undefined], ['2', 'document.invoice.line[].b', 'Template0']]);
    expect(c.rules).toHaveBeenCalledExactlyOnceWith('X', { templateStandardId: 3 });
  });
  it('is cached per profile, channel and template', async () => {
    const c = client();
    const cache = createRulesCache({ ttlMs: 1000 });
    const a = await loadRules(cache, c as never, 'a', 'X', 0);
    expect(await loadRules(cache, c as never, 'a', 'X', 0)).toBe(a);
    await loadRules(cache, c as never, 'a', 'X', 1);
    await loadRules(cache, c as never, 'a', 'Y', 0);
    await loadRules(cache, c as never, 'b', 'X', 0);
    expect(c.rules).toHaveBeenCalledTimes(4);
  });
  it('a failed fetch rejects and is not cached', async () => {
    const c = client();
    c.rules.mockRejectedValueOnce(new Error('down'));
    const cache = createRulesCache({ ttlMs: 1000 });
    await expect(loadRules(cache, c as never, 'a', 'X', 0)).rejects.toThrow('down');
    expect((await loadRules(cache, c as never, 'a', 'X', 0)).readable).toHaveLength(2);
  });
});

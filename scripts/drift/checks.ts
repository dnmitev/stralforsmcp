/** Pure drift checks: observed live data in, findings out. No I/O. A finding holds a fixed check name and a count, never observed text. */
import { createHash } from 'node:crypto';
import { flattenRulesWithCriteria, type LocalRule, type RuleNode } from '../../src/stralfors/rules.ts';

export interface Finding { check: string; count: number }
export interface Template { standardId: number; type?: { name: string } | undefined }

const found = (check: string, count: number): Finding[] => (count > 0 ? [{ check, count }] : []);
const without = (a: readonly string[], b: readonly string[]) => a.filter((x) => !b.includes(x)).length;
const local = (tree: readonly RuleNode[]): LocalRule[] => flattenRulesWithCriteria(tree).local;

/** criterion kinds this server's parser does not know (they would surface as `unknown` findings to callers) */
export const unknownKinds = (tree: readonly RuleNode[]): Finding[] =>
  found('unknown-criterion', local(tree).flatMap((r) => r.criteria).filter((c) => c.kind === 'unknown').length);

export const channelDiff = (observed: readonly string[], expected?: readonly string[]): Finding[] =>
  expected === undefined ? [] : [...found('channel-new', without(observed, expected)), ...found('channel-missing', without(expected, observed))];

export const versionDiff = (observed: string | undefined, expected?: string): Finding[] =>
  expected !== undefined && observed !== expected ? [{ check: 'api-version', count: 1 }] : [];

/** .NET-only regex constructs show up as patterns JS cannot compile: counted, the pattern text never leaves */
export function badPatterns(tree: readonly RuleNode[]): Finding[] {
  let n = 0;
  for (const c of local(tree).flatMap((r) => r.criteria)) {
    if (c.kind !== 'pattern') continue;
    try { new RegExp(c.pattern); } catch { n++; }
  }
  return found('pattern-not-compilable', n);
}

/** SHA-256 of every free-text criterion and *When expression (sorted, unique): the only place vendor prose passes through to callers */
export function criteriaHashes(tree: readonly RuleNode[]): string[] {
  const texts = local(tree).flatMap((r) => r.criteria).flatMap((c) => (c.kind === 'criteria' ? [c.prose] : c.kind === 'optional_when' || c.kind === 'required_when' || c.kind === 'invalid_when' ? [c.expr] : []));
  return [...new Set(texts.map((t) => createHash('sha256').update(t).digest('hex')))].sort();
}

export const hashDiff = (observed: readonly string[], baseline: readonly string[]): Finding[] =>
  found('criteria-changed', without(observed, baseline) + without(baseline, observed));

export const templateShape = (list: readonly Template[]): Finding[] => found('template-shape', list.filter((t) => !t.type?.name).length);

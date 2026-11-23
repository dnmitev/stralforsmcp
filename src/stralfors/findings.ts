/** Pure: maps Stralfors validation failures to findings. Messages are fixed templates; the only vendor text that passes through is rule content ADR 0016 and 0017 allow (patterns, examples, allowed values, *When expressions). */
import { hintFor, parseCriterion, toJsonPath, type Criterion } from './rules.ts';
import type { Violation } from './errors.ts';

export interface Finding {
  source: 'local' | 'stralfors';
  ruleId?: string;
  tag?: string;
  path: string;
  kind: string;
  message: string;
  expected?: string;
  example?: string;
  serverError?: true;
}

const PATH = /^[A-Za-z0-9_.[\]]+$/;
const DIGITS = /^\d+$/;
const TAG = /^[A-Za-z0-9_]+$/;

export function fromViolations(violations: readonly Violation[]): Finding[] {
  return violations.flatMap((v): Finding[] => {
    const ok = PATH.test(v.path);
    const path = ok ? toJsonPath(v.path) : '';
    const id = v.ruleId !== undefined && DIGITS.test(v.ruleId) ? v.ruleId : undefined;
    const base = { source: 'stralfors' as const, ...(id ? { ruleId: id } : {}), ...(v.tag && TAG.test(v.tag) ? { tag: v.tag } : {}), path };
    if (v.serverError) {
      const named = id ? ` Report rule ${id} to Stralfors.` : '';
      return [{ ...base, kind: 'rule_engine', serverError: true, message: `Stralfors' rule engine failed on this rule; this is not a problem with the document.${named}` }];
    }
    const unknown = (): Finding => ({ ...base, kind: 'unknown', message: hintFor({ kind: 'unknown' }, ok ? path : 'A document field', id ?? 'unknown')! });
    if (!ok) return [unknown()];
    const cs = v.criteria.map(parseCriterion);
    const example = cs.find((c): c is Extract<Criterion, { kind: 'example' }> => c.kind === 'example')?.text;
    const out: Finding[] = [];
    for (const c of cs) {
      const message = c.kind === 'optional' ? undefined : hintFor(c, path, id ?? 'unknown');
      if (message === undefined || out.some((f) => f.kind === c.kind)) continue;
      out.push({ ...base, kind: c.kind, message, ...(c.kind === 'pattern' ? { expected: c.pattern } : {}), ...(example !== undefined ? { example } : {}) });
    }
    return out.length > 0 ? out : [unknown()];
  });
}

// System.Text.Json names an unreadable field as a JSON path ('$.document.x[0].y') and adds 'dto' (the model came out null): drop 'dto' when a field is named
const JSON_PATH = /^\$\.?/;
const MODEL = 'dto';

export function fromBadRequest(errors: Readonly<Record<string, unknown>>): Finding[] {
  const keys = Object.keys(errors);
  const named = keys.length > 1 ? keys.filter((k) => k !== MODEL) : keys;
  return named.map((raw) => {
    const key = raw.replace(JSON_PATH, '');
    const path = PATH.test(key) ? toJsonPath(key) : '';
    return { source: 'stralfors', path, kind: 'shape', message: `${path || 'A field'} is not accepted by Stralfors; compare ${path ? 'it' : 'the document'} with get_example_invoice.` };
  });
}

export const fromFields = (fields: readonly string[]): Finding[] =>
  fields.map((f) => ({ source: 'local', path: f, kind: 'shape', message: `${f} is missing or has the wrong type.` }));

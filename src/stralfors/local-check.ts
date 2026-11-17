/** Pure: checks a document against parsed rules. Emits only findings it is certain of; anything uncertain is left to the dry run. */
import type { Finding } from './findings.ts';
import { hintFor, type Criterion, type LocalRule } from './rules.ts';

const MAX_FINDINGS = 200;
const MAX_PATTERN = 500;
const MAX_TEXT = 500; // ponytail: a longer value is left to the dry run; with the nested-quantifier skip this bounds regex work
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const PLAIN = /^-?\d+(\.\d+)?$/;
const ABSENT = Symbol('absent');
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const get = (o: Obj, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : ABSENT); // own properties only
const camel = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Exact decimal compare of two PLAIN numbers, no Number(). */
function decCmp(a: string, b: string): number {
  const parse = (s: string) => {
    const neg = s.startsWith('-');
    const [i = '', f = ''] = s.replace('-', '').split('.');
    const int = i.replace(/^0+/, ''), frac = f.replace(/0+$/, '');
    return { neg: neg && (int !== '' || frac !== ''), int, frac };
  };
  const x = parse(a), y = parse(b);
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  const mag = x.int.length !== y.int.length ? x.int.length - y.int.length : cmp(x.int, y.int) || cmp(x.frac, y.frac);
  return Math.sign(mag) * (x.neg ? -1 : 1);
}

const plain = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
  return s !== undefined && PLAIN.test(s) ? s : undefined;
};
const today10 = (d: Date): string => d.toISOString().slice(0, 10);

// A quantified group whose body itself holds a quantifier or an alternation: the shapes that backtrack exponentially, e.g. (a+)+ (.*)* (a|aa)+
// ponytail: conservative textual detector; it may skip a safe pattern (left to the dry run) but never lets these shapes run
const RISKY = /\((?:\?:)?[^()]*(?:[+*|]|\{\d*,\d*\})[^()]*\)(?:[+*]|\{\d*,\d*\})/;
const compiled = new Map<string, RegExp | undefined>();
/** Compiles a vendor pattern once; undefined when it is too long, unparseable or risky. */
function compile(pattern: string): RegExp | undefined {
  if (compiled.has(pattern)) return compiled.get(pattern);
  let re: RegExp | undefined;
  if (pattern.length <= MAX_PATTERN && !RISKY.test(pattern)) try { re = new RegExp(pattern); } catch { /* unparseable: dry run decides */ }
  if (compiled.size >= 1000) compiled.clear(); // ponytail: patterns come from the cached rules of a few channels; the cap only bounds memory
  compiled.set(pattern, re);
  return re;
}

/** True when the value certainly violates the criterion. `parent` serves exclusive. */
function violates(c: Criterion, v: unknown, parent: Obj, today: string): boolean {
  if (c.kind === 'exclusive') return v !== null && v !== ABSENT && (() => { const o = get(parent, camel(c.field)); return o !== ABSENT && o !== null; })();
  if (c.kind === 'required') return v === ABSENT || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  if (v === ABSENT || v === null) return false;
  const scalar = typeof v === 'string' || typeof v === 'number';
  switch (c.kind) {
    case 'array': return !Array.isArray(v);
    case 'valid_items': case 'valid_templates': return scalar && !c.values.some((x) => x.toLowerCase() === String(v).toLowerCase()); // ponytail: case-insensitive, never a false invalid; exact casing is the dry run's
    case 'pattern': {
      if (typeof v !== 'string' || v.length > MAX_TEXT) return false;
      const re = compile(c.pattern);
      return re !== undefined && !re.test(v);
    }
    case 'numeric': return typeof v === 'string' ? !/^\d+$/.test(v) : typeof v === 'number' && !(Number.isInteger(v) && v >= 0);
    case 'decimal': return typeof v === 'string' ? !DECIMAL.test(v) : false;
    case 'min_value': case 'max_value': {
      const a = plain(v), b = plain(c.n);
      return a !== undefined && b !== undefined && (c.kind === 'min_value' ? decCmp(a, b) < 0 : decCmp(a, b) > 0);
    }
    case 'max_count': return Array.isArray(v) && v.length > Number(c.n);
    case 'unique': return Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object') && new Set(v.map((x) => `${typeof x}:${String(x)}`)).size < v.length;
    case 'date_not_past': {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(v)) return false;
      const t = Date.parse(v);
      return !Number.isNaN(t) && (v.length === 10 ? v : today10(new Date(t))) < today;
    }
    default: return false;
  }
}

export function localCheck(document: unknown, rules: readonly LocalRule[], today: Date = new Date()): Finding[] {
  if (!isObj(document)) return [];
  const day = today10(today);
  const optional = new Set(rules.filter((r) => r.criteria.some((c) => c.kind === 'optional_when')).map((r) => r.path));
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const rule of rules) {
    const segs = rule.path.split('.').slice(1); // first segment names the document itself
    if (segs.length === 0) continue;
    const apply = (parent: Obj, key: string, path: string): void => {
      const v = get(parent, key);
      const example = rule.criteria.find((c) => c.kind === 'example');
      for (const c of rule.criteria) {
        if (out.length >= MAX_FINDINGS) return;
        if (c.kind === 'required' && (rule.anyGroup || optional.has(rule.path))) continue;
        if (!violates(c, v, parent, day)) continue;
        const message = hintFor(c, path, rule.id);
        const dup = `${rule.id}\0${path}\0${c.kind}`;
        if (message === undefined || seen.has(dup)) continue;
        seen.add(dup);
        out.push({ source: 'local', ruleId: rule.id, ...(rule.tag ? { tag: rule.tag } : {}), path, kind: c.kind, message,
          ...(c.kind === 'pattern' ? { expected: c.pattern, ...(example?.kind === 'example' ? { example: example.text } : {}) } : {}) });
      }
    };
    const walk = (node: Obj, i: number, prefix: string): void => {
      const seg = segs[i]!;
      const isArr = seg.endsWith('[]');
      const key = isArr ? seg.slice(0, -2) : seg;
      if (i === segs.length - 1) { apply(node, key, `${prefix}.${key}`); return; }
      const next = get(node, key);
      if (isArr) {
        if (!Array.isArray(next)) return;
        for (let n = 0; n < next.length && out.length < MAX_FINDINGS; n++) if (isObj(next[n])) walk(next[n] as Obj, i + 1, `${prefix}.${key}[${n}]`);
      } else if (isObj(next)) walk(next, i + 1, `${prefix}.${key}`);
    };
    walk(document, 0, 'document');
  }
  return out.sort((a, b) => cmp(a.path, b.path) || cmp(a.ruleId ?? '', b.ruleId ?? ''));
}

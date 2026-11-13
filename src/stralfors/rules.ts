/** Pure: parses Stralfors rule criteria into kinds and fixed, readable hints. No I/O. Vendor text is dropped except where a kind is marked pass-through. */

export interface RuleNode {
  id: string;
  tag?: string | null;
  parameter: string;
  isRequired?: boolean;
  ruleCriterias?: readonly string[] | null;
  expectedPattern?: string | null;
  exampleValue?: string | null;
  hasDependencies?: boolean;
  dependencyOperator?: string | null;
  dependencies?: readonly RuleNode[];
}

export type Criterion =
  | { kind: 'required' | 'optional' | 'array' | 'array_items' | 'default_channel' | 'numeric' | 'decimal' | 'unique' | 'exact_casing' | 'date_not_past' | 'file_name' | 'unknown' }
  | { kind: 'valid_items' | 'valid_templates' | 'valid_channels'; values: string[] }
  | { kind: 'pattern'; pattern: string }
  | { kind: 'example'; text: string }
  | { kind: 'min_value' | 'max_value' | 'max_count'; n: string }
  | { kind: 'period_order'; part: 'date' | 'time' }
  | { kind: 'exclusive'; field: string }
  | { kind: 'optional_when' | 'required_when' | 'invalid_when'; expr: string }
  | { kind: 'depends_on'; operator: 'any' | 'all'; ids: string[] }
  | { kind: 'criteria'; prose: string };

export interface ReadableRule {
  id: string;
  path: string;
  tag?: string;
  required: boolean;
  hints: string[];
  pattern?: string;
  example?: string;
  dependsOn?: { operator: 'any' | 'all'; rules: { id: string; path: string }[] };
}

/** Document.Invoice.PaymentMeans[].PaymentId -> document.invoice.paymentMeans[].paymentId */
export const toJsonPath = (parameter: string): string => parameter.split('.').map((s) => s.charAt(0).toLowerCase() + s.slice(1)).join('.');

const SIMPLE: Readonly<Record<string, Criterion['kind']>> = {
  Required: 'required', Optional: 'optional', ArrayExpected: 'array', ArrayWithValidItemsExpected: 'array_items', ValidDefaultChannel: 'default_channel',
  NumericExpected: 'numeric', DecimalExpected: 'decimal', UniqueValueExpected: 'unique', ExactCasingExpected: 'exact_casing',
  DateNotInPastExpected: 'date_not_past', FileNameExpected: 'file_name',
};
const LISTS: Readonly<Record<string, 'valid_items' | 'valid_templates' | 'valid_channels'>> = { ValidItems: 'valid_items', ValidTemplates: 'valid_templates', ValidChannels: 'valid_channels' };
const WHEN: Readonly<Record<string, 'optional_when' | 'required_when' | 'invalid_when'>> = { OptionalWhen: 'optional_when', RequiredWhen: 'required_when', InvalidWhen: 'invalid_when' };
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined); // no inherited keys such as "constructor"
const NUMBER = /^-?\d+(\.\d+)?$/;
const DEPENDENCIES = /^HasDependencies\s*\((AnyRequired|AllRequired)\)\s*:?\s*(.*)$/s;

export function parseCriterion(raw: string): Criterion {
  const dep = DEPENDENCIES.exec(raw.trim());
  if (dep) return { kind: 'depends_on', operator: dep[1] === 'AnyRequired' ? 'any' : 'all', ids: [...dep[2]!.matchAll(/#([^:\s,]+)/g)].map((m) => m[1]!) };
  const i = raw.indexOf(':');
  const head = (i < 0 ? raw : raw.slice(0, i)).trim();
  const rest = i < 0 ? '' : raw.slice(i + 1).trim();
  const simple = own(SIMPLE, head);
  if (simple) return { kind: simple } as Criterion;
  const list = own(LISTS, head);
  if (list) return { kind: list, values: rest.split(',').map((v) => v.trim()).filter(Boolean) };
  const when = own(WHEN, head);
  if (when) return { kind: when, expr: rest };
  switch (head) {
    case 'ExpectedPattern': return { kind: 'pattern', pattern: rest };
    case 'ExampleValue': return { kind: 'example', text: rest };
    case 'MinValue': return NUMBER.test(rest) ? { kind: 'min_value', n: rest } : { kind: 'unknown' };
    case 'MaxValue': return NUMBER.test(rest) ? { kind: 'max_value', n: rest } : { kind: 'unknown' };
    case 'MaxCount': { const n = /\sis\s(\d+)\.?\s*$/.exec(rest); return n ? { kind: 'max_count', n: n[1]! } : { kind: 'unknown' }; }
    case 'StartDateNotPastEndDateExpected': return { kind: 'period_order', part: 'date' };
    case 'StartTimeNotPastEndTimeExpected': return { kind: 'period_order', part: 'time' };
    case 'CanNotBeCombinedWith': return rest ? { kind: 'exclusive', field: rest } : { kind: 'unknown' };
    case 'ValidationCriteria': return rest ? { kind: 'criteria', prose: rest } : { kind: 'unknown' };
    default: return { kind: 'unknown' };
  }
}

const LIST_CAP = 20;
const list = (values: string[]): string => values.slice(0, LIST_CAP).join(', ') + (values.length > LIST_CAP ? `, … (${values.length - LIST_CAP} more)` : '');
const DECIMAL_MIN = /^-79228162514264337593543950335(\.0+)?$/; // C# decimal limits: "no bound", by direction
const DECIMAL_MAX = /^79228162514264337593543950335(\.0+)?$/;
const GLOSS: ReadonlyArray<readonly [string, string]> = [
  ['(O1E)', 'one of the keyed fields must exist'], ['(VPDF)', 'must be a PDF meeting the print criteria'], ['(CT)', 'credit notes only'],
  ['(VAB)', 'must differ from the buyer'], ['(VAS)', 'must differ from the seller'],
];

/** The fixed sentence for one criterion, or undefined when it has no hint. `paths` resolves dependency rule ids; `id` names the rule for unknown kinds. */
export function hintFor(c: Criterion, path: string, id: string, paths: ReadonlyMap<string, string> = new Map()): string | undefined {
  switch (c.kind) {
    case 'required': return `${path} is required.`;
    case 'optional': return `${path} is optional.`;
    case 'array': return `${path} must be an array.`;
    case 'array_items': return `${path} must be an array; every item must satisfy its own rules.`;
    case 'valid_items': return `${path} must be one of: ${list(c.values)}.`;
    case 'valid_templates': return `${path} must be one of the standard templates ${list(c.values)}.`;
    case 'valid_channels': return `${path} must only contain channels the agreement allows: ${list(c.values)}.`;
    case 'default_channel': return 'The agreement defines the default channel; the first entry of channelPriority must match it.';
    case 'pattern': return `${path} must match the pattern ${c.pattern}.`;
    case 'example': return undefined;
    case 'numeric': return `${path} must contain digits only.`;
    case 'decimal': return `${path} must be a decimal number.`;
    case 'min_value': return DECIMAL_MIN.test(c.n) ? undefined : `${path} must be at least ${c.n}.`;
    case 'max_value': return DECIMAL_MAX.test(c.n) ? undefined : `${path} must be at most ${c.n}.`;
    case 'max_count': return `${path} may contain at most ${c.n} items.`;
    case 'unique': return `Values of ${path} must be unique within the array.`;
    case 'exact_casing': return `${path} is case-sensitive; use the exact spelling from the allowed values.`;
    case 'date_not_past': return `${path} must not be a date in the past.`;
    case 'period_order': return `The start ${c.part} of ${path} must not be after its end ${c.part}.`;
    case 'file_name': return `${path} must be a valid file name with an extension.`;
    case 'exclusive': return `${path} cannot be set together with ${c.field}.`;
    case 'optional_when': return `${path} is optional when ${c.expr}.`; // pass-through (published rule metadata)
    case 'required_when': return `${path} is required when ${c.expr}.`;
    case 'invalid_when': return `${path} is invalid when ${c.expr}.`;
    case 'depends_on': return `When ${path} is present, ${c.operator === 'any' ? 'any one of' : 'all of'} these must be present: ${c.ids.map((x) => paths.get(x) ?? `rule ${x}`).join(', ')}.`;
    case 'criteria': return `Rule note: ${GLOSS.find(([code]) => c.prose.includes(code))?.[1] ?? c.prose}.`.replace(/\.\.$/, '.');
    case 'unknown': return `${path} has a rule of a kind this server does not know (rule ${id}).`;
  }
}

/** Parsed criteria of a rule; a rule-level expectedPattern counts as a pattern criterion when the list has none. */
export function criteriaOf(rule: RuleNode): Criterion[] {
  const out = (rule.ruleCriterias ?? []).map(parseCriterion);
  if (rule.expectedPattern && !out.some((c) => c.kind === 'pattern')) out.push({ kind: 'pattern', pattern: rule.expectedPattern });
  return out;
}

export const hintsFor = (rule: RuleNode, paths?: ReadonlyMap<string, string>): string[] => {
  const path = toJsonPath(rule.parameter);
  return [...new Set(criteriaOf(rule).map((c) => hintFor(c, path, rule.id, paths)).filter((h): h is string => h !== undefined))];
};

export interface LocalRule {
  id: string;
  path: string;
  tag?: string;
  criteria: Criterion[];
  /** child of an AnyRequired parent: any one of the group suffices, so the local required check does not apply */
  anyGroup?: true;
}

/** Depth-first flat list; children become entries of their own and the parent keeps a dependsOn. The same walk also yields the parsed criteria per rule. */
export function flattenRulesWithCriteria(tree: readonly RuleNode[]): { readable: ReadableRule[]; local: LocalRule[] } {
  const all: RuleNode[] = [];
  const walk = (rs: readonly RuleNode[]) => { for (const r of rs) { all.push(r); walk(r.dependencies ?? []); } };
  walk(tree);
  const anyKids = new Set(all.filter((r) => r.dependencyOperator === 'AnyRequired').flatMap((r) => (r.dependencies ?? []).map((k) => k.id)));
  const paths = new Map(all.map((r) => [r.id, toJsonPath(r.parameter)]));
  const readable: ReadableRule[] = [];
  const local: LocalRule[] = [];
  for (const r of all) {
    const kids = r.dependencies ?? [];
    const op = r.dependencyOperator === 'AllRequired' ? 'all' : r.dependencyOperator === 'AnyRequired' ? 'any' : undefined;
    const criteria = criteriaOf(r);
    const rule: ReadableRule = { id: r.id, path: paths.get(r.id)!, required: r.isRequired === true, hints: hintsFor(r, paths) };
    if (r.tag) rule.tag = r.tag;
    const pattern = criteria.find((c) => c.kind === 'pattern');
    if (pattern) rule.pattern = pattern.pattern;
    if (r.exampleValue) rule.example = r.exampleValue;
    if (op && kids.length > 0) rule.dependsOn = { operator: op, rules: kids.map((k) => ({ id: k.id, path: paths.get(k.id)! })) };
    readable.push(rule);
    local.push({ id: r.id, path: rule.path, ...(r.tag ? { tag: r.tag } : {}), criteria, ...(anyKids.has(r.id) ? { anyGroup: true as const } : {}) });
  }
  return { readable, local };
}

export const flattenRules = (tree: readonly RuleNode[]): ReadableRule[] => flattenRulesWithCriteria(tree).readable;

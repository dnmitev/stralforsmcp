import * as z from 'zod/v4';
import type { StralforsClient } from '../stralfors/index.ts';
import { flattenRules, type ReadableRule } from '../stralfors/rules.ts';
import { resolveProfile } from './profile.ts';
import type { RulesCache } from './rules-cache.ts';
import type { ToolDef } from './tools.ts';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;

const ruleSchema = z.strictObject({
  id: z.string(),
  path: z.string(),
  tag: z.string().optional(),
  required: z.boolean(),
  hints: z.array(z.string()),
  pattern: z.string().optional(),
  example: z.string().optional(),
  dependsOn: z.strictObject({ operator: z.enum(['any', 'all']), rules: z.array(z.strictObject({ id: z.string(), path: z.string() })) }).optional(),
});

export const getRulesInput = z.object({
  profile: z.string().min(1).optional(),
  channel: z.string().min(1),
  templateStandardId: z.number().int().min(0).optional(),
  requiredOnly: z.boolean().optional(),
  pathPrefix: z.string().min(1).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});
export const getRulesOutput = z.object({
  profile: z.string(),
  channel: z.string(),
  templateStandardId: z.number(),
  total: z.number(),
  offset: z.number(),
  returned: z.number(),
  hasMore: z.boolean(),
  rules: z.array(ruleSchema),
});

export interface RulesToolDeps {
  clients: ReadonlyMap<string, Pick<StralforsClient, 'rules'>>;
  cache: RulesCache;
}

/** path is the prefix itself or continues it at a segment boundary ("a.b" matches "a.b.c" and "a.b[].c", not "a.bc") */
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
/** cached rules are shared between callers: hand out copies */
const copy = (r: ReadableRule): ReadableRule => ({
  ...r,
  hints: [...r.hints],
  ...(r.dependsOn ? { dependsOn: { operator: r.dependsOn.operator, rules: r.dependsOn.rules.map((x) => ({ ...x })) } } : {}),
});

export function createGetRules(deps: RulesToolDeps): ToolDef<typeof getRulesInput, typeof getRulesOutput> {
  return {
    spec: { name: 'get_rules', access: 'read' },
    title: 'Get rules',
    description: `Lists the validation rules of one delivery channel in readable form: JSON path, whether it is required, plain-language hints, pattern and example where published, and dependencies. Rules are per channel and template. Results are paginated (limit up to ${MAX_LIMIT}); hasMore tells whether another page exists. requiredOnly and pathPrefix filter locally.`,
    inputSchema: getRulesInput,
    outputSchema: getRulesOutput,
    annotations: READ_ONLY,
    async run(args) {
      const { profile, client } = resolveProfile(deps.clients, args.profile);
      const templateStandardId = args.templateStandardId ?? 0;
      const offset = args.offset ?? 0;
      const limit = args.limit ?? DEFAULT_LIMIT;
      const all = await deps.cache.get(profile, args.channel, templateStandardId, () => client.rules(args.channel, { templateStandardId }).then((r) => flattenRules(r.rules)));
      const { pathPrefix } = args;
      const filtered = all.filter((r) => (!args.requiredOnly || r.required) && (pathPrefix === undefined || under(r.path, pathPrefix)));
      const page = filtered.slice(offset, offset + limit).map(copy);
      return { profile, channel: args.channel, templateStandardId, total: filtered.length, offset, returned: page.length, hasMore: offset + page.length < filtered.length, rules: page };
    },
  };
}

export const EXAMPLE_NOTES: readonly string[] = [
  'Leaf values are patterns or placeholders, not valid data; replace every one before validating.',
  'The agreement is chosen by its label when validating or sending; the example never carries an agreement id.',
  'consignmentId must be 10-50 characters and unique per agreement: duplicates are refused for 35 days in production and 7 days in test.',
  'documentHeader.sTT.externalDocId is the reference that tracking lookups can later be searched by.',
];

export const getExampleInput = z.object({
  profile: z.string().min(1).optional(),
  channels: z.array(z.string().min(1)).min(1).max(5),
  defaultChannel: z.string().min(1).optional(),
  templateStandardId: z.number().int().min(0).optional(),
});
export const getExampleOutput = z.object({
  profile: z.string(),
  channels: z.array(z.string()),
  example: z.record(z.string(), z.unknown()),
  notes: z.array(z.string()),
});

export function createGetExampleInvoice(deps: { clients: ReadonlyMap<string, Pick<StralforsClient, 'documentExample'>> }): ToolDef<typeof getExampleInput, typeof getExampleOutput> {
  return {
    spec: { name: 'get_example_invoice', access: 'read' },
    title: 'Get example invoice',
    description: 'Returns the example invoice payload for one or more channels, without the agreement id, plus fixed notes on how to use it. Leaf values are patterns or placeholders, not valid data.',
    inputSchema: getExampleInput,
    outputSchema: getExampleOutput,
    annotations: READ_ONLY,
    async run(args) {
      const { profile, client } = resolveProfile(deps.clients, args.profile);
      const { actionId: _agreement, ...example } = await client.documentExample({ channels: args.channels, defaultChannel: args.defaultChannel, templateStandardId: args.templateStandardId });
      return { profile, channels: args.channels, example, notes: [...EXAMPLE_NOTES] };
    },
  };
}

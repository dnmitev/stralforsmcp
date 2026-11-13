import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { AgreementNotFoundError, BadRequestError, RequestValidationError, StralforsError, ValidationFailedError } from '../stralfors/errors.ts';
import { fromBadRequest, fromFields, fromViolations, type Finding } from '../stralfors/findings.ts';
import type { Config, StralforsClient } from '../stralfors/index.ts';
import { localCheck } from '../stralfors/local-check.ts';
import { AGREEMENT_REQUIRED, UNKNOWN_AGREEMENT } from './channels.ts';
import { resolveProfile } from './profile.ts';
import type { RulesCache } from './rules-cache.ts';
import { loadRules } from './rules-load.ts';
import { ToolInputError, type ToolDef } from './tools.ts';

const MAX_FINDINGS = 100;
const MAX_CHANNELS = 5;
const CHANNEL_PATH = 'document.documentHeader.channelPriority';

const part = z.record(z.string(), z.unknown()).optional();
export const validateInput = z.object({
  profile: z.string().min(1).optional(),
  agreement: z.string().min(1).optional(), // agreement LABEL, never an id
  document: z.looseObject({ documentHeader: part, invoice: part }),
  consignmentId: z.string().min(10).max(50).optional(),
});
const finding = z.strictObject({
  source: z.enum(['local', 'stralfors']),
  ruleId: z.string().optional(),
  tag: z.string().optional(),
  path: z.string(),
  kind: z.string(),
  message: z.string(),
  expected: z.string().optional(),
  example: z.string().optional(),
  serverError: z.literal(true).optional(),
});
export const validateOutput = z.object({
  valid: z.boolean(),
  stage: z.enum(['input', 'local', 'dry_run', 'passed']),
  findings: z.array(finding),
  moreMayFollow: z.boolean(),
});

export interface ValidateDeps {
  clients: ReadonlyMap<string, Pick<StralforsClient, 'rules' | 'validateInvoice'>>;
  config: Pick<Config, 'profiles'>;
  cache: RulesCache;
  uuid?: () => string;
}

const RULES_UNAVAILABLE: Finding = { source: 'local', path: '', kind: 'rules_unavailable', message: 'The rules of one channel could not be loaded, so they were not checked locally; the dry run still decides.' };

const order = (a: Finding, b: Finding) => (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.ruleId ?? '') < (b.ruleId ?? '') ? -1 : (a.ruleId ?? '') > (b.ruleId ?? '') ? 1 : 0);
const result = (stage: 'input' | 'local' | 'dry_run', found: Finding[]): z.infer<typeof validateOutput> => {
  const sorted = found.sort(order);
  const findings = sorted.length > MAX_FINDINGS
    ? [...sorted.slice(0, MAX_FINDINGS), { source: 'local' as const, path: '', kind: 'truncated', message: `${sorted.length - MAX_FINDINGS} more findings were omitted; fix these and validate again.` }]
    : sorted;
  return { valid: false, stage, findings, moreMayFollow: true };
};

export function createValidateInvoice(deps: ValidateDeps): ToolDef<typeof validateInput, typeof validateOutput> {
  const uuid = deps.uuid ?? randomUUID;
  return {
    spec: { name: 'validate_invoice', access: 'validate' },
    title: 'Validate invoice',
    description: 'Dry-runs an invoice document and creates nothing. Three stages, stopping at the first with findings: input shape, a local check against the cached channel rules, then the native dry run. One round per call: when moreMayFollow is true, fix the findings and call again. valid is true only after the dry run accepts the document. See get_rules for the rules of a channel.',
    inputSchema: validateInput,
    outputSchema: validateOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args) {
      const { profile, client } = resolveProfile(deps.clients, args.profile);
      const agreements = deps.config.profiles[profile]?.agreements ?? [];
      const agreement = args.agreement === undefined ? (agreements.length === 1 ? agreements[0] : undefined) : agreements.find((a) => a.label === args.agreement);
      if (!agreement) throw new ToolInputError(args.agreement === undefined ? AGREEMENT_REQUIRED : UNKNOWN_AGREEMENT);

      const { documentHeader, invoice } = args.document;
      const missing = [...(documentHeader ? [] : ['document.documentHeader']), ...(invoice ? [] : ['document.invoice'])];
      if (!documentHeader || !invoice) return result('input', fromFields(missing));

      const cp = documentHeader.channelPriority;
      const channels = [...new Set((Array.isArray(cp) ? cp : []).filter((c): c is string => typeof c === 'string'))];
      if (channels.length === 0) return result('local', [{ source: 'local', path: CHANNEL_PATH, kind: 'required', message: `${CHANNEL_PATH} is required.` }]);
      if (channels.length > MAX_CHANNELS) return result('local', [{ source: 'local', path: CHANNEL_PATH, kind: 'shape', message: `${CHANNEL_PATH} may list at most ${MAX_CHANNELS} channels.` }]);
      const sid = (documentHeader.templateParameter as { standardId?: unknown } | undefined)?.standardId;
      const templateStandardId = typeof sid === 'number' && Number.isInteger(sid) && sid >= 0 ? sid : 0;

      const settled = await Promise.allSettled(channels.map((c) => loadRules(deps.cache, client, profile, c, templateStandardId)));
      const unavailable: Finding[] = [];
      const local = [];
      for (const s of settled) {
        if (s.status === 'fulfilled') local.push(...s.value.local);
        else if (s.reason instanceof StralforsError) unavailable.push({ ...RULES_UNAVAILABLE });
        else throw s.reason;      }
      const found = localCheck(args.document, local);
      if (found.length > 0) return result('local', [...found, ...unavailable]);

      try {
        await client.validateInvoice({ actionId: agreement.id, consignmentId: args.consignmentId ?? `validate-${uuid()}`, document: { ...args.document, documentHeader, invoice } });
      } catch (e) {
        if (e instanceof ValidationFailedError) return result('dry_run', [...fromViolations(e.violations), ...unavailable]);
        if (e instanceof BadRequestError) return result('dry_run', [...fromBadRequest(e.errors ?? {}), ...unavailable]);
        if (e instanceof RequestValidationError) return result('dry_run', [...fromFields(e.fields), ...unavailable]);
        if (e instanceof AgreementNotFoundError) throw new ToolInputError('agreement not found for this profile'); // ponytail: audit reason is bad_input, not agreement_not_found; callTool is out of scope
        throw e;
      }
      return unavailable.length > 0 ? result('dry_run', unavailable) : { valid: true, stage: 'passed', findings: [], moreMayFollow: false };
    },
  };
}

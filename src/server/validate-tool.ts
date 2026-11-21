import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { AgreementNotFoundError, BadRequestError, NotDryRunError, RequestValidationError, StralforsError, ValidationFailedError } from '../stralfors/errors.ts';
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
const CHANNEL_NAME = /^[A-Za-z0-9]{1,40}$/;
const MAX_TEMPLATE_ID = 1_000_000;
const CHANNEL_PATH = 'document.documentHeader.channelPriority';
const TEMPLATE_PATH = 'document.documentHeader.templateParameter.standardId';
// ponytail: fixed window; local findings from rules older than this no longer stop the dry run (a vendor relaxation must not block for the cache TTL)
const LOCAL_AUTHORITY_MS = 300_000;

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
  config: Pick<Config, 'profiles' | 'env'>;
  cache: RulesCache;
  uuid?: () => string;
  now?: () => number;
}

const RULES_UNAVAILABLE: Finding = { source: 'local', path: '', kind: 'rules_unavailable', message: 'The rules of one channel could not be loaded, so they were not checked locally; the dry run still decides.' };

const REJECTED: Finding = { source: 'stralfors', path: 'document', kind: 'rejected', message: 'Stralfors rejected the document without naming a field; compare it with get_example_invoice and get_rules.' };
const rejected = (f: Finding[]): Finding[] => (f.length > 0 ? f : [{ ...REJECTED }]);
const order = (a: Finding, b: Finding) => (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.ruleId ?? '') < (b.ruleId ?? '') ? -1 : (a.ruleId ?? '') > (b.ruleId ?? '') ? 1 : 0);
const result = (stage: 'input' | 'local' | 'dry_run', found: Finding[]): z.infer<typeof validateOutput> => {
  const sorted = found.sort(order);
  const findings = sorted.length > MAX_FINDINGS
    ? [...sorted.slice(0, MAX_FINDINGS), { source: 'local' as const, path: '', kind: 'truncated', message: `${sorted.length - MAX_FINDINGS} more findings were omitted; fix these and validate again.` }]
    : sorted;
  return { valid: false, stage, findings, moreMayFollow: true };
};

/** Fixed text: the response is never echoed. */
const NOT_A_DRY_RUN = 'validate response did not confirm a dry run';

export function createValidateInvoice(deps: ValidateDeps): ToolDef<typeof validateInput, typeof validateOutput> {
  const uuid = deps.uuid ?? randomUUID;
  const prod = deps.config.env === 'prod';
  return {
    spec: { name: 'validate_invoice', access: 'validate' },
    title: 'Validate invoice',
    description: 'Dry-runs an invoice document and creates nothing. Three stages, stopping at the first with findings: input shape, a local check against the cached channel rules, then the native dry run. One round per call: when moreMayFollow is true, fix the findings and call again. valid is true only after the dry run accepts the document. Use synthetic data only: never real recipients or customer data. See get_rules for the rules of a channel.',
    inputSchema: validateInput,
    outputSchema: validateOutput,
    // In PROD the route is a write verb whose safety rests on the vendor honouring test=true: do not promise read-only.
    annotations: { readOnlyHint: !prod, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
      if (channels.some((c) => !CHANNEL_NAME.test(c))) return result('local', [{ source: 'local', path: CHANNEL_PATH, kind: 'shape', message: `${CHANNEL_PATH} entries must be 1 to 40 letters or digits.` }]);
      const sid = (documentHeader.templateParameter as { standardId?: unknown } | undefined)?.standardId;
      if (sid !== undefined && !(typeof sid === 'number' && Number.isInteger(sid) && sid >= 0 && sid <= MAX_TEMPLATE_ID)) {
        return result('local', [{ source: 'local', path: TEMPLATE_PATH, kind: 'shape', message: `${TEMPLATE_PATH} must be a whole number from 0 to ${MAX_TEMPLATE_ID}.` }]);
      }
      const templateStandardId = sid ?? 0;

      const now = deps.now ?? Date.now;
      const settled = await Promise.allSettled(channels.map((c) => loadRules(deps.cache, client, profile, c, templateStandardId, now)));
      const unavailable: Finding[] = [];
      const local = [];
      // The vendor applies one channel's rules, not their union, and may relax a rule while ours is cached: local findings are
      // certain (and stop the dry run) only for one channel with rules fetched in the last LOCAL_AUTHORITY_MS (ADR 0017 item 3).
      let authoritative = channels.length === 1;
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          local.push(...s.value.local);
          if (now() - s.value.fetchedAt > LOCAL_AUTHORITY_MS) authoritative = false;
        } else if (s.reason instanceof StralforsError) unavailable.push({ ...RULES_UNAVAILABLE });
        else throw s.reason;
      }
      const found = authoritative ? localCheck(args.document, local) : [];
      if (found.length > 0) return result('local', [...found, ...unavailable]);

      let answer;
      try {
        answer = await client.validateInvoice({ actionId: agreement.id, consignmentId: args.consignmentId ?? `validate-${uuid()}`, document: { ...args.document, documentHeader, invoice } });
      } catch (e) {
        if (e instanceof ValidationFailedError) return result('dry_run', [...rejected(fromViolations(e.violations)), ...unavailable]);
        if (e instanceof BadRequestError) return result('dry_run', [...rejected(fromBadRequest(e.errors ?? {})), ...unavailable]);
        if (e instanceof RequestValidationError) return result('dry_run', [...fromFields(e.fields), ...unavailable]);
        if (e instanceof AgreementNotFoundError) throw new ToolInputError('agreement not found for this profile', 'agreement_not_found');
        throw e;
      }
      // Fail closed: PROD needs proof that the vendor treated this as a dry run; an explicit isTest false is refused everywhere.
      const isTest = 'isTest' in answer ? answer.isTest : undefined;
      if (isTest === false || (prod && isTest !== true)) throw new NotDryRunError(NOT_A_DRY_RUN);
      return unavailable.length > 0 ? result('dry_run', unavailable) : { valid: true, stage: 'passed', findings: [], moreMayFollow: false };
    },
  };
}

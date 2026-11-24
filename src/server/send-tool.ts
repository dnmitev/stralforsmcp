import * as z from 'zod/v4';
import { AgreementNotFoundError, BadRequestError, ConflictError, ResponseTooLargeError, StralforsError, TimeoutError, TlsError, UpstreamError, ValidationFailedError } from '../stralfors/errors.ts';
import { fromBadRequest, fromViolations, type Finding } from '../stralfors/findings.ts';
import type { Config, StralforsClient } from '../stralfors/index.ts';
import { WRITE_SCOPE } from '../policy/index.ts';
import { resolveAgreement, resolveProfile } from './profile.ts';
import { ToolInputError, type ToolDef } from './tools.ts';
import { finding, rejected } from './validate-tool.ts';

const part = z.record(z.string(), z.unknown());
export const sendInput = z.object({
  profile: z.string().min(1).optional(),
  agreement: z.string().min(1).optional(), // agreement LABEL, never an id
  document: z.looseObject({ documentHeader: part, invoice: part }),
  // ADR 0028 item 3: required and never generated, so a caller's retry reuses it and the vendor recognises the duplicate
  consignmentId: z.string().min(10).max(50),
});
export const sendOutput = z.object({
  outcome: z.enum(['sent', 'rejected', 'unknown']),
  consignmentId: z.string(),
  findings: z.array(finding),
  hint: z.string(),
});
type Out = z.infer<typeof sendOutput>;

export interface SendDeps {
  clients: ReadonlyMap<string, Pick<StralforsClient, 'sendInvoice' | 'token'>>;
  config: Pick<Config, 'profiles'>;
}

/** Fixed texts: no vendor text, value or id. */
export const CANNOT_SEND = 'this profile cannot send';
const HINT = {
  sent: 'Stralfors accepted the invoice. Follow it with track_document by invoice number. Never send it again with a new consignmentId.',
  rejected: 'Stralfors did not accept the invoice; nothing was sent. Fix the findings (validate_invoice helps) and send again.',
  duplicate: 'Stralfors already received an invoice under this consignmentId; the first send stands. Check it with track_document and do not send it again, not even with a new consignmentId.',
  unknown: 'The outcome is unknown: the invoice may have arrived. Check with track_document by invoice number, and if you send again use the same consignmentId, never a new one.',
} as const;
const DUPLICATE: Finding = { source: 'stralfors', path: 'consignmentId', kind: 'duplicate', message: 'This consignmentId was already used with this agreement; the first send stands. Check it with track_document; a different invoice needs a new consignmentId.' };

export function createSendInvoice(deps: SendDeps): ToolDef<typeof sendInput, typeof sendOutput> {
  return {
    spec: { name: 'send_invoice', access: 'write' },
    title: 'Send invoice (TEST)',
    description: 'Sends an invoice document to the Stralfors TEST environment for real: it creates a consignment that cannot be undone. Only on TEST. Run validate_invoice first. consignmentId is required: reuse the same one when you retry, so a repeat is refused as a duplicate instead of sent twice. outcome is sent, rejected (nothing sent; see findings) or unknown (it may have arrived: check track_document, never resend with a new consignmentId). Use synthetic data only.',
    inputSchema: sendInput,
    outputSchema: sendOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    auditReason: (out) => (out.outcome === 'unknown' ? 'outcome_unknown' : out.outcome), // 'unknown' is already a token verify code
    async run(args) {
      const { profile, client } = resolveProfile(deps.clients, args.profile);
      const agreement = resolveAgreement(deps.config.profiles[profile]?.agreements ?? [], args.agreement);
      // ADR 0028 item 2: the request's claims are the union of all profiles; the chosen profile's own token must hold the write scope (fail closed if never fetched)
      if (!client.token.peek()?.hasScope(WRITE_SCOPE)) throw new ToolInputError(CANNOT_SEND, 'scope');
      const done = (outcome: Out['outcome'], findings: Finding[] = [], hint: string = HINT[outcome]): Out => ({ outcome, consignmentId: args.consignmentId, findings, hint });
      try {
        await client.sendInvoice({ actionId: agreement.id, consignmentId: args.consignmentId, document: args.document });
      } catch (e) {
        // a failure while fetching the token comes before any POST: nothing was sent, so no answer from that stage may read as a send outcome (R-49)
        if (e instanceof StralforsError && e.operation === 'token') throw e;
        if (e instanceof ValidationFailedError) return done('rejected', rejected(fromViolations(e.violations)));
        if (e instanceof BadRequestError) return done('rejected', rejected(fromBadRequest(e.errors ?? {})));
        if (e instanceof ConflictError) return done('rejected', [{ ...DUPLICATE }], HINT.duplicate); // usually a retry after unknown: never invite a resend
        // the body may have arrived: a timeout, a 5xx or network failure (a reset can surface as TLS), an answer too large to read
        if (e instanceof TimeoutError || e instanceof UpstreamError || e instanceof ResponseTooLargeError || e instanceof TlsError) return done('unknown');
        if (e instanceof AgreementNotFoundError) throw new ToolInputError('agreement not found for this profile', 'agreement_not_found');
        throw e; // nothing was accepted (auth, busy, write guard, cancelled before start): the call fails with its kind
      }
      return done('sent');
    },
  };
}

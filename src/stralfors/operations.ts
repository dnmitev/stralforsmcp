import { z } from 'zod';
import { currentSignal, detached } from './abort.ts';
import { CancelledError, RequestValidationError, SchemaError } from './errors.ts';

const V = '/rest/outputmanagement/apiomni/v2/invoices';
const TT = '/rest/outputmanagement/tracktrace/v1';
const CL = '/rest/outputmanagement/channellookup/v1';

// The API sometimes double-encodes a JSON body as a JSON string; unwrap it before validating.
const unwrap = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }, schema);

// Schemas are lenient on purpose: extra keys are kept, optional where the live API is inconsistent.
const apiInfoSchema = z.looseObject({ name: z.string().optional(), version: z.string().optional(), status: z.string().optional() });
const healthSchema = z.looseObject({ status: z.string(), name: z.string().optional(), detailChecks: z.array(z.looseObject({ status: z.string() })).optional() });
const channelsSchema = z.array(z.string());
const templatesSchema = z.array(z.looseObject({ standardId: z.number(), type: z.looseObject({ name: z.string() }).optional() }));
const Rule = z.looseObject({
  id: z.string(),
  tag: z.string().nullish(),
  parameter: z.string(),
  isRequired: z.boolean().optional(),
  isOptional: z.boolean().optional(),
  ruleCriterias: z.array(z.string()).nullish(),
  expectedPattern: z.string().nullish(),
  exampleValue: z.string().nullish(),
  hasDependencies: z.boolean().optional(),
  dependencyOperator: z.string().nullish(),
  get dependencies() {
    return z.array(Rule);
  },
});
export const rulesResponseSchema = z.looseObject({ channel: z.string(), rules: z.array(Rule) });
const documentSchema = unwrap(z.looseObject({}));
const validateRequest = z.looseObject({
  actionId: z.uuid(),
  consignmentId: z.string().min(10).max(50),
  document: z.looseObject({ documentHeader: z.record(z.string(), z.unknown()), invoice: z.record(z.string(), z.unknown()) }),
});
const validateResponse = unwrap(
  z.union([
    z.undefined().transform(() => ({ ok: true as const })),
    z.looseObject({ guid: z.string().optional(), isTest: z.boolean().optional(), document: z.record(z.string(), z.unknown()).optional() })
      .transform((v) => ({ ok: true as const, guid: v.guid, isTest: v.isTest, document: v.document })),
  ]),
);

// spec: documents is nullable; live STT answers null when nothing matches yet (V-8, 2026-11-23)
const trackPageSchema = unwrap(z.looseObject({ documents: z.array(z.looseObject({ documentId: z.string().optional() })).nullable().transform((d) => d ?? []), lastDocuments: z.boolean() }));
const trackHistorySchema = unwrap(z.looseObject({}));

/** The one lookup request shape: the tool input extends it and the client re-checks it before any I/O. Candidates are personal identifiers: bounded, never echoed. */
export const lookupRequest = z.object({ channels: z.array(z.string().regex(/^[A-Za-z0-9]{1,40}$/)).min(1).max(4), candidates: z.array(z.string().min(1).max(40)).min(1).max(1000) });
// well-formed UTF-16 only: a lone surrogate would make encodeURIComponent throw before the poll request, so it is a schema error instead
const lookupStarted = unwrap(z.looseObject({ correlationId: z.string().min(1).refine((v) => v.isWellFormed()) }));
const lookupResult = unwrap(z.looseObject({ results: z.array(z.looseObject({ channel: z.string(), matchedCandidates: z.array(z.string()), error: z.string().nullish() })) }));

interface Opts<T> { schema?: z.ZodType<T>; query?: Record<string, string>; operation?: string; noReplay?: boolean }
interface Core {
  get<T = unknown>(path: string, opts?: Opts<T>): Promise<T>;
  post<T = unknown>(path: string, body: unknown, opts?: Opts<T>): Promise<T>;
  put<T = unknown>(path: string, body: unknown, opts?: Opts<T>): Promise<T>;
}
const defined = (o: Record<string, string | number | boolean | undefined>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));

function checkInvoice(body: unknown): void {
  const check = validateRequest.safeParse(body);
  if (check.success) return;
  const fields = [...new Set(check.error.issues.map((i) => String(i.path[0])))];
  throw new RequestValidationError(`invalid request: ${fields.join(', ')}`, { fields });
}

export function operations(c: Core) {
  const get = <T>(operation: string, path: string, schema: z.ZodType<T>, query?: Record<string, string>) => c.get(path, { schema, query, operation });
  return {
    apiInfo: () => get('apiInfo', '/rest/outputmanagement/apiomni/v2/apiinfo', apiInfoSchema),
    healthV1: () => get('healthV1', '/rest/outputmanagement/apiomni/v1/manage/health', healthSchema),
    channels: (actionId?: string) => get('channels', `${V}/channels`, channelsSchema, defined({ actionId })),
    templates: () => get('templates', `${V}/templates`, templatesSchema),
    rules: (channel: string, o: { templateStandardId?: number; emailTemplateStandardId?: number; required?: boolean } = {}) =>
      get('rules', `${V}/rules`, rulesResponseSchema, defined({ channel, templateStandardId: o.templateStandardId ?? 0, emailTemplateStandardId: o.emailTemplateStandardId, required: o.required })),
    documentExample: (o: { channels: string | string[]; defaultChannel?: string; templateStandardId?: number }) =>
      get('documentExample', `${V}/document`, documentSchema, defined({ channels: [o.channels].flat().join(','), defaultChannel: o.defaultChannel, templateStandardId: o.templateStandardId })),
    trackDocuments: (f: { invoiceNumber?: string; extDocumentId?: string; documentId?: string; lastDocumentId?: string; channelId?: number }) =>
      get('trackDocuments', `${TT}/document/documents`, trackPageSchema, defined(f)),
    trackHistory: (documentId: string) => get('trackHistory', `${TT}/document/${encodeURIComponent(documentId)}/documentinfohistory`, trackHistorySchema),
    /** Starts a lookup (POST). Candidates are personal identifiers: they only travel in the body, never in a path, query or operation name. */
    async channelLookup(body: z.input<typeof lookupRequest>) {
      const check = lookupRequest.safeParse(body);
      if (!check.success) throw new RequestValidationError(`invalid request: ${[...new Set(check.error.issues.map((i) => String(i.path[0])))].join(', ')}`, { fields: [...new Set(check.error.issues.map((i) => String(i.path[0])))] });
      return c.post(`${CL}/lookup`, body, { schema: lookupStarted, operation: 'channelLookup', noReplay: true });
    },
    channelLookupResult: (correlationId: string) => get('channelLookupResult', `${CL}/lookup/${encodeURIComponent(correlationId)}`, lookupResult),
    /** Dry run only: always test=true, there is no way to send test=false from here. */
    async validateInvoice(body: z.input<typeof validateRequest>) {
      checkInvoice(body);
      return c.put(`${V}/validate`, body, { schema: validateResponse, query: { test: 'true' }, operation: 'validateInvoice' });
    },
    /**
     * Sends for real (ADR 0028): the write guard opens this route on TEST with STRALFORS_ALLOW_WRITE only. One POST, never replayed
     * (noReplay) and never retried; once started it runs outside the caller's abort scope, so a cancel cannot leave the outcome unknown.
     */
    async sendInvoice(body: z.input<typeof validateRequest>): Promise<{ ok: true }> {
      checkInvoice(body);
      if (currentSignal()?.aborted) throw new CancelledError('request cancelled by the caller'); // nothing started yet: send nothing
      try {
        await detached(() => c.post(`${V}/true`, body, { operation: 'sendInvoice', noReplay: true }));
      } catch (e) {
        // only the send's own SchemaError comes after a 2xx (accepted, whatever the body says); a token refresh one means nothing was sent
        if (!(e instanceof SchemaError && e.operation === 'sendInvoice')) throw e;
      }
      return { ok: true };
    },
  };
}

import * as z from 'zod/v4';
import { AgreementNotFoundError } from '../stralfors/errors.ts';
import type { StralforsClient } from '../stralfors/index.ts';
import { documentOutcome, minimiseDocument, minimiseHistory } from '../stralfors/tracking.ts';
import { resolveProfile } from './profile.ts';
import { ToolInputError, KIND_TEXT, type ToolDef } from './tools.ts';

const ONE_OF = 'exactly one of invoiceNumber, extDocumentId or documentId is required';
const NEEDS_ONE = 'history needs a single document';

// The one-of rule lives in run(), not in a zod refine: a refine would make the SDK reject before callTool and skip the audit.
export const trackInput = z.object({
  profile: z.string().min(1).optional(),
  invoiceNumber: z.string().min(1).max(100).optional(),
  extDocumentId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9\-_.]+$/).optional(),
  documentId: z.string().min(1).max(10).regex(/^[A-Za-z0-9]+$/).optional(),
  history: z.boolean().optional(),
  cursor: z.string().min(1).max(10).optional(),
  channelId: z.number().int().optional(),
});
const outcome = z.enum(['delivered', 'in_progress', 'refused', 'failed', 'unknown']);
const doc = z.looseObject({ documentId: z.string().optional(), outcome, channels: z.array(z.looseObject({})) });
export const trackOutput = z.object({
  profile: z.string(),
  documents: z.array(doc),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
  checkedAt: z.string(),
});

export interface TrackDeps {
  clients: ReadonlyMap<string, Pick<StralforsClient, 'trackDocuments' | 'trackHistory'>>;
  now?: () => number;
}

// ponytail: a JSON 404 is classified agreement_not_found by the client and shown as bad_input in the audit; a text 404 stays route_not_found.
// Revisit with V-8 (does 404 mean "no match"?) and a dedicated not_found kind.
const notFound = async <T>(p: Promise<T>): Promise<T> => p.catch((e: unknown) => {
  throw e instanceof AgreementNotFoundError ? new ToolInputError(KIND_TEXT('not_found' as never)) : e;
});

export function createTrackDocument(deps: TrackDeps): ToolDef<typeof trackInput, typeof trackOutput> {
  const now = deps.now ?? Date.now;
  return {
    spec: { name: 'track_document', access: 'read' },
    title: 'Track document',
    description: 'Reads the delivery status of an invoice by invoice number, external document id or document id (exactly one). Creates nothing and never returns recipient data. Returns an outcome per document and per channel plus the raw status, optionally the delivery history of one document. Status can lag by hours to days; one read per call, no polling.',
    inputSchema: trackInput,
    outputSchema: trackOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args) {
      const keys = [args.invoiceNumber, args.extDocumentId, args.documentId].filter((k) => k !== undefined);
      if (keys.length !== 1) throw new ToolInputError(ONE_OF);
      const { profile, client } = resolveProfile(deps.clients, args.profile);
      const page = await notFound(client.trackDocuments({ invoiceNumber: args.invoiceNumber, extDocumentId: args.extDocumentId, documentId: args.documentId, lastDocumentId: args.cursor, channelId: args.channelId }));
      const documents = page.documents.map(minimiseDocument);
      if (args.history) {
        const only = documents.length === 1 ? documents[0] : undefined;
        if (!only) throw new ToolInputError(NEEDS_ONE);
        const history = minimiseHistory(await notFound(client.trackHistory(only.documentId ?? '')));
        const d = Number(history['deliveryDocumentsDelivered']);
        const t = Number(history['deliveryDocumentsTotal']);
        only['history'] = history;
        only.outcome = documentOutcome(only.channels, { delivered: d, total: t });
      }
      const last = documents.at(-1);
      return { profile, documents, hasMore: !page.lastDocuments, ...(!page.lastDocuments && last?.documentId ? { nextCursor: last.documentId } : {}), checkedAt: new Date(now()).toISOString() };
    },
  };
}

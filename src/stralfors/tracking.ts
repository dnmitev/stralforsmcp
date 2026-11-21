// Pure mapper for Track & Trace answers. Output is built by picking allowed fields only (never a delete-list),
// so a field the vendor adds later cannot leak recipient data.
export type Outcome = 'delivered' | 'in_progress' | 'refused' | 'failed' | 'unknown';

const EXACT: Record<string, Outcome> = {};
const add = (o: Outcome, names: string[]) => names.forEach((n) => (EXACT[n.toLowerCase()] = o));
add('delivered', ['Delivered', 'VerifiedDelivered', 'Opened', 'PaymentRegistered', 'PaymentRejected', 'PaymentLinkOpened', 'PaymentCancelled', 'PaymentOpened', 'ApprovedForPayment', 'Paid', 'FeedbackReceived']);
add('refused', ['Rejected']);
add('failed', ['Cancelled', 'Deleted', 'Error', 'FileEmpty', 'ValidationFailed']);
add('in_progress', ['Registered', 'RegisteredInFile', 'Processing', 'Test', 'PrintFileCreated', 'ProductionFileCreated']);
const PREFIX: [string, Outcome][] = [['signorder', 'delivered'], ['printing', 'in_progress'], ['enveloping', 'in_progress'], ['reprints', 'in_progress'], ['postprocessing', 'in_progress']];

export function channelOutcome(status: string): Outcome {
  const s = status.replace(/\s+/g, '').toLowerCase();
  return (Object.hasOwn(EXACT, s) ? EXACT[s] : undefined) ?? PREFIX.find(([p]) => s.startsWith(p))?.[1] ?? 'unknown';
}

export function documentOutcome(channels: { outcome: Outcome }[], hist?: { delivered: number; total: number }): Outcome {
  const has = (o: Outcome) => channels.some((c) => c.outcome === o);
  if (has('delivered') || (hist !== undefined && hist.total > 0 && hist.delivered === hist.total)) return 'delivered';
  if (channels.length === 0) return 'unknown';
  if (has('in_progress')) return 'in_progress';
  if (has('unknown')) return 'unknown'; // a status we do not know may be a later success: never shown as progress or as final
  return has('refused') ? 'refused' : 'failed';
}

/** A history message is kept only when it is exactly one of the known status names (no prefix groups: "Printing for <name>" must not pass); anything else may carry recipient text. */
export const safeMessage = (s: string): string | undefined => (s.length <= MAX_STATUS && Object.hasOwn(EXACT, s.replace(/\s+/g, '').toLowerCase()) ? s : undefined);
const MAX_STATUS = 64;
export const OTHER_STATUS = 'other'; // shown instead of a status that is not an exact known name

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null ? (v as Rec) : {});
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : []);
const scalar = (v: unknown) => ['string', 'number', 'boolean'].includes(typeof v);
/** Copies the named keys that hold a string, number or boolean; objects and arrays are dropped. A status is kept only as an exact known name, else masked. */
const pick = (o: Rec, keys: string[]): Rec => Object.fromEntries(keys.filter((k) => scalar(o[k])).map((k) => [k, k === 'status' ? (typeof o[k] === 'string' ? safeMessage(o[k]) ?? OTHER_STATUS : OTHER_STATUS) : o[k]]));
const status = (o: Rec) => (typeof o['status'] === 'string' ? o['status'] : '');

export interface TrackedChannel { outcome: Outcome; status?: string; [k: string]: unknown }
export interface TrackedDocument { documentId?: string; outcome: Outcome; channels: TrackedChannel[]; [k: string]: unknown }
export type History = Rec;

export function minimiseDocument(raw: unknown): TrackedDocument {
  const d = rec(raw);
  const channels = list(d['channels']).map((c) => ({
    ...pick(c, ['channelId', 'channelName', 'status']),
    outcome: channelOutcome(status(c)),
    ...pick(c, ['deliveryTime', 'documents', 'pages']),
    comments: list(c['statusComments']).map((m) => pick(m, ['status', 'dateTime', 'paymentMethod'])),
  }));
  return { ...pick(d, ['documentId', 'extDocumentId', 'invoiceNumber', 'lastChange']), outcome: documentOutcome(channels), channels };
}

export function minimiseHistory(raw: unknown): History {
  const h = rec(raw);
  return {
    ...pick(h, ['status', 'arrivalTime', 'deliveryDocumentsDelivered', 'deliveryDocumentsTotal']),
    channels: list(h['channels']).map((c) => ({
      ...pick(c, ['channelId', 'channelName', 'status']),
      outcome: channelOutcome(status(c)),
      deliveryDocuments: list(c['deliveryDocuments']).map((dd) => ({
        ...pick(dd, ['deliveryDocumentId']),
        events: list(dd['statusHistory']).map((e) => {
          const message = typeof e['message'] === 'string' ? safeMessage(e['message']) : undefined;
          return { ...pick(e, ['dateTime']), ...(message === undefined ? {} : { message }) };
        }),
      })),
    })),
  };
}

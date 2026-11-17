/*
 * track_document pure mapper (03-02a Task 1), red. Signatures the developer must satisfy.
 *
 * src/stralfors/tracking.ts
 *   type Outcome = 'delivered' | 'in_progress' | 'refused' | 'failed' | 'unknown'
 *   channelOutcome(status: string): Outcome                  lower-case + strip all whitespace, exact table or prefix group, else 'unknown'
 *   documentOutcome(channels: { outcome: Outcome }[], hist?: { delivered: number; total: number }): Outcome
 *   minimiseDocument(raw: unknown): TrackedDocument          allowlist pick; never a receiver field, never an unknown field
 *   minimiseHistory(raw: unknown): History                   same, events[].message only if safeMessage passes
 *   safeMessage(s: string): string | undefined               s only if its stripped, lower-cased form is an EXACT status name (no prefix groups)
 *
 * src/stralfors/operations.ts (client methods, base /rest/outputmanagement/tracktrace/v1, GET)
 *   trackDocuments(f: { invoiceNumber?; extDocumentId?; documentId?; lastDocumentId?: string; channelId?: number }) -> { documents: unknown[]; lastDocuments: boolean }
 *       path document/documents, sends exactly the given filters
 *   trackHistory(documentId: string)                        path document/<encodeURIComponent(id)>/documentinfohistory
 *
 * src/server/track-tool.ts
 *   createTrackDocument({ clients, now? }) -> ToolDef named track_document, access 'read', no requiredScope
 *   output { profile, documents[], hasMore, nextCursor?, checkedAt }; one-of rule thrown from run() as ToolInputError (fixed text)
 *
 * Synthetic data only.
 */
import { describe, expect, it } from 'vitest';
import { channelOutcome, documentOutcome, minimiseDocument, minimiseHistory, safeMessage, type Outcome } from './tracking.ts';
import { channel, rawDoc, rawHistory, receiverCanaries } from '../../test/helpers/track.ts';

const T: Record<Exclude<Outcome, 'unknown'>, string[]> = {
  delivered: ['Delivered', 'VerifiedDelivered', 'Opened', 'PaymentRegistered', 'PaymentRejected', 'PaymentLinkOpened', 'PaymentCancelled', 'PaymentOpened', 'ApprovedForPayment', 'Paid', 'FeedbackReceived', 'SignOrder', 'SignOrderSent', 'SignOrderCompleted'],
  refused: ['Rejected'],
  failed: ['Cancelled', 'Deleted', 'Error', 'FileEmpty', 'ValidationFailed'],
  in_progress: ['Registered', 'RegisteredInFile', 'Processing', 'Test', 'PrintFileCreated', 'Production file created', 'Printing', 'PrintingStarted', 'Enveloping', 'EnvelopingDone', 'Reprints', 'ReprintsQueued', 'PostProcessing', 'PostProcessingX'],
};
const rows = Object.entries(T).flatMap(([o, ss]) => ss.map((s) => [s, o] as [string, string]));

describe('channelOutcome table (A6)', () => {
  it.each(rows)('%s -> %s', (s, o) => expect(channelOutcome(s)).toBe(o));
  it.each(rows)('%s is case-insensitive', (s, o) => {
    expect(channelOutcome(s.toLowerCase())).toBe(o);
    expect(channelOutcome(s.toUpperCase())).toBe(o);
  });
  it.each(rows)('%s ignores whitespace anywhere', (s, o) => {
    expect(channelOutcome(`  ${s}\t`)).toBe(o);
    expect(channelOutcome(s.split('').join(' '))).toBe(o);
    expect(channelOutcome(`\n${s} \n`)).toBe(o);
  });
  it('spaced spellings of the matrix', () => {
    expect(channelOutcome('Verified Delivered')).toBe('delivered');
    expect(channelOutcome('Production file created')).toBe('in_progress');
    expect(channelOutcome('rejected')).toBe('refused');
  });
  it.each(['SomethingNew', '', '   ', 'Sign', 'SignOrde', 'Printin', 'Envelopin', 'Reprint', 'PostProcessin', 'XPrinting', 'MySignOrder', 'DeliveredX', 'Deliver', 'Rejecte', 'RejectedX', 'Cancel', 'CancelledX', 'Regist', 'Tes', 'Testing', 'Paid2', 'Open'])('%j -> unknown', (s) => {
    expect(channelOutcome(s)).toBe('unknown');
  });
  it('exact names are not prefix groups: a longer string of an exact name is unknown', () => {
    for (const s of ['DeliveredLater', 'ErrorCode', 'ProcessingDone', 'Registered2', 'TestRun']) expect(channelOutcome(s), s).toBe('unknown');
  });
});

describe('documentOutcome (A7, AC-4)', () => {
  const o = (...s: Outcome[]) => s.map((outcome) => ({ outcome }));
  it.each<[string, Outcome[], Outcome]>([
    ['rejected + delivered', ['refused', 'delivered'], 'delivered'],
    ['delivered first', ['delivered', 'refused'], 'delivered'],
    ['rejected + registered', ['refused', 'in_progress'], 'in_progress'],
    ['rejected + unknown', ['refused', 'unknown'], 'in_progress'],
    ['failed + unknown', ['failed', 'unknown'], 'in_progress'],
    ['unknown alone is still in progress', ['unknown'], 'in_progress'],
    ['rejected', ['refused'], 'refused'],
    ['cancelled + rejected', ['failed', 'refused'], 'refused'],
    ['rejected + cancelled', ['refused', 'failed'], 'refused'],
    ['cancelled', ['failed'], 'failed'],
    ['two failed', ['failed', 'failed'], 'failed'],
    ['delivered beats in progress', ['in_progress', 'delivered'], 'delivered'],
    ['no channels', [], 'unknown'],
  ])('%s', (_n, c, expected) => expect(documentOutcome(o(...c))).toBe(expected));
  it('history delivered == total > 0 forces delivered', () => {
    expect(documentOutcome(o('refused'), { delivered: 1, total: 1 })).toBe('delivered');
    expect(documentOutcome(o('in_progress'), { delivered: 3, total: 3 })).toBe('delivered');
    expect(documentOutcome([], { delivered: 2, total: 2 })).toBe('delivered');
  });
  it('history that is not fully delivered changes nothing', () => {
    expect(documentOutcome(o('refused'), { delivered: 0, total: 0 })).toBe('refused');
    expect(documentOutcome(o('refused'), { delivered: 1, total: 2 })).toBe('refused');
    expect(documentOutcome(o('failed'), { delivered: 2, total: 1 })).toBe('failed');
    expect(documentOutcome([], { delivered: 0, total: 0 })).toBe('unknown');
  });
});

describe('safeMessage', () => {
  it('keeps only known status strings, case and whitespace insensitive', () => {
    for (const m of ['Delivered', 'Verified Delivered', 'delivered', 'REGISTERED']) expect(safeMessage(m), m).toBe(m);
  });
  it('keeps the prefix-group statuses out of messages: they are channel statuses, and a prefix match would pass recipient text', () => {
    for (const m of ['Printing', 'SignOrderSent', 'Enveloping done']) expect(channelOutcome(m), m).not.toBe('unknown'); // still mapped as channel statuses
    for (const m of ['Printing for Alice Smith', 'Enveloping Alice Smith', 'Reprints Alice', 'PostProcessing Alice', 'SignOrder Alice', 'Printing']) expect(safeMessage(m), m).toBeUndefined();
  });
  it.each(['', 'a', 'ok', 'Delivered to Alice Smith', 'Delivered to <name> at <street>', 'Status: ok / done-1.2_x', 'constructor'])('drops %j', (m) => {
    expect(safeMessage(m)).toBeUndefined();
  });
});

describe('channelOutcome ignores inherited properties', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])('%s is unknown', (n) => {
    expect(channelOutcome(n)).toBe('unknown');
  });
});

describe('input shape', () => {
  it('whitespace of any kind inside a status is ignored', () => {
    expect(channelOutcome('Verified\t Delivered')).toBe('delivered');
    expect(safeMessage('Verified  \n Delivered')).toBe('Verified  \n Delivered');
  });
  it('null, scalars and non-object list items are treated as empty', () => {
    expect(minimiseDocument(null)).toStrictEqual({ outcome: 'unknown', channels: [] });
    expect(minimiseDocument('x')).toStrictEqual({ outcome: 'unknown', channels: [] });
    const d = minimiseDocument({ channels: [null, 'x', 5] });
    expect(d.channels).toHaveLength(3);
    expect(d.channels.every((c) => c.outcome === 'unknown')).toBe(true);
  });
  it('a dropped message leaves no message key', () => {
    const h = minimiseHistory({ channels: [{ deliveryDocuments: [{ statusHistory: [{ dateTime: 't', message: 'Delivered to Bob' }] }] }] }) as { channels: { deliveryDocuments: { events: unknown[] }[] }[] };
    expect(h.channels[0]!.deliveryDocuments[0]!.events).toStrictEqual([{ dateTime: 't' }]);
  });
});

describe('only scalar values are picked', () => {
  it('an object under any allowed key is dropped', () => {
    const k = 'NESTED-CANARY';
    const o = { [k]: 1 };
    const doc = minimiseDocument({ documentId: o, extDocumentId: o, invoiceNumber: o, lastChange: o, channels: [{ channelId: o, channelName: o, status: o, deliveryTime: o, documents: o, pages: o, statusComments: [{ status: o, dateTime: o, paymentMethod: o }] }] });
    const hist = minimiseHistory({ status: o, arrivalTime: o, deliveryDocumentsDelivered: o, deliveryDocumentsTotal: o, channels: [{ channelId: o, channelName: o, status: o, deliveryDocuments: [{ deliveryDocumentId: o, statusHistory: [{ dateTime: o, message: o }, { dateTime: [k] }] }] }] });
    expect(JSON.stringify([doc, hist])).not.toContain(k);
  });
  it('string, number and boolean survive', () => {
    expect(minimiseDocument({ documentId: 'A', lastChange: 1, invoiceNumber: false })).toMatchObject({ documentId: 'A', lastChange: 1, invoiceNumber: false });
  });
});

describe('status masking', () => {
  it('a status that is not an exact known name, or is over-long, becomes the placeholder everywhere', () => {
    const long = 'Delivered'.padEnd(65, ' ');
    const doc = minimiseDocument({ channels: [{ status: 'Printing for Alice', statusComments: [{ status: 'Printing for Alice' }, { status: long }] }] });
    const hist = minimiseHistory({ status: 'Printing for Alice', channels: [{ status: long }] });
    expect(JSON.stringify([doc, hist])).not.toMatch(/Alice|\s{5}/);
    expect(doc.channels[0]).toMatchObject({ status: 'other', outcome: 'in_progress', comments: [{ status: 'other' }, { status: 'other' }] });
    expect(hist).toMatchObject({ status: 'other', channels: [{ status: 'other', outcome: 'delivered' }] });
  });
});

describe('minimiseDocument', () => {
  it('keeps only the allowed shape and never a receiver value or an unknown field', () => {
    const c = receiverCanaries();
    const m = minimiseDocument(rawDoc(c));
    expect(m).toEqual({
      documentId: 'M8I4', extDocumentId: 'ext-1', invoiceNumber: 'INV-1', lastChange: '2030-01-02T03:04:05Z', outcome: 'delivered',
      channels: [{
        channelId: 9, channelName: 'eBrev/WeMail', status: 'Delivered', outcome: 'delivered', deliveryTime: '2030-01-03T00:00:00Z', documents: 1, pages: 2,
        comments: [{ status: 'Delivered', dateTime: '2030-01-02T03:04:05Z', paymentMethod: 'Card' }],
      }],
    });
    const s = JSON.stringify(m);
    for (const v of Object.values(c)) expect(s).not.toContain(v);
    for (const k of ['receiver', 'eAddress', 'customerNumber', 'subCustomerId', 'documentKeyId', 'fileId', 'additionalDatas', 'vendorNewField', 'comment"']) expect(s, k).not.toContain(k);
  });
  it('optional fields are absent, not undefined, when upstream omits them', () => {
    const c = receiverCanaries();
    const raw = rawDoc(c, { extDocumentId: undefined, invoiceNumber: undefined, channels: [channel('Registered', { statusComments: [{ status: 'Registered', dateTime: 'x', comment: c.comment }] })] });
    const m = minimiseDocument(raw) as { channels: Record<string, unknown>[] } & Record<string, unknown>;
    expect(Object.keys(m).sort()).toEqual(['channels', 'documentId', 'lastChange', 'outcome']);
    expect(Object.keys(m.channels[0]!).sort()).toEqual(['channelId', 'channelName', 'comments', 'documents', 'outcome', 'pages', 'status']);
    expect(m.channels[0]!.comments).toEqual([{ status: 'Registered', dateTime: 'x' }]);
    expect(m.outcome).toBe('in_progress');
  });
  it('maps each channel and derives the document outcome', () => {
    const c = receiverCanaries();
    const m = minimiseDocument(rawDoc(c, { channels: [channel('Rejected'), channel('SomethingNew', { channelId: 3 })] })) as { outcome: string; channels: { outcome: string; status: string }[] };
    expect(m.channels.map((x) => [x.status, x.outcome])).toEqual([['Rejected', 'refused'], ['other', 'unknown']]);
    expect(m.outcome).toBe('in_progress');
  });
  it('a document without channels is unknown with an empty list', () => {
    const m = minimiseDocument(rawDoc(receiverCanaries(), { channels: undefined })) as { outcome: string; channels: unknown[] };
    expect(m.channels).toEqual([]);
    expect(m.outcome).toBe('unknown');
  });
  it('does not mutate its input', () => {
    const raw = Object.freeze(rawDoc(receiverCanaries()));
    expect(() => minimiseDocument(raw)).not.toThrow();
  });
});

describe('minimiseHistory', () => {
  it('keeps the allowed shape, maps outcomes, drops receiver data', () => {
    const c = receiverCanaries();
    const h = minimiseHistory(rawHistory(c));
    expect(h).toEqual({
      status: 'Delivered', arrivalTime: '2030-01-01T00:00:00Z', deliveryDocumentsDelivered: 1, deliveryDocumentsTotal: 1,
      channels: [{ channelId: 9, channelName: 'eBrev/WeMail', status: 'Delivered', outcome: 'delivered', deliveryDocuments: [{ deliveryDocumentId: 'D1', events: [{ dateTime: '2030-01-02T03:04:05Z', message: 'Delivered' }] }] }],
    });
    const s = JSON.stringify(h);
    for (const v of Object.values(c)) expect(s).not.toContain(v);
  });
  it('an event whose message fails the allowlist keeps its dateTime but loses the message', () => {
    const c = receiverCanaries();
    const bad = `Delivered to <${c.receiverName}> at <${c.receiverAddress}>`;
    const raw = rawHistory(c, { channels: [{ channelId: 9, channelName: 'n', status: 'Delivered', deliveryDocuments: [{ deliveryDocumentId: 'D1', statusHistory: [{ dateTime: 't1', message: bad }, { dateTime: 't2', message: 'Delivered' }, { dateTime: 't4', message: 'Delivered to Alice Smith' }, { dateTime: 't3' }] }] }] });
    const h = minimiseHistory(raw) as { channels: { deliveryDocuments: { events: Record<string, unknown>[] }[] }[] };
    expect(h.channels[0]!.deliveryDocuments[0]!.events).toEqual([{ dateTime: 't1' }, { dateTime: 't2', message: 'Delivered' }, { dateTime: 't4' }, { dateTime: 't3' }]);
    expect(JSON.stringify(h)).not.toContain(c.receiverName);
  });
  it('missing channels become an empty list', () => {
    const h = minimiseHistory({ status: 'Registered', arrivalTime: 't', deliveryDocumentsDelivered: 0, deliveryDocumentsTotal: 0 }) as { channels: unknown[] };
    expect(h.channels).toEqual([]);
  });
});

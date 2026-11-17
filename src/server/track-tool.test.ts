/*
 * track_document (03-02a Task 1), red. API under test: createTrackDocument({ clients, now? }) from ./track-tool.ts,
 * spec { name: 'track_document', access: 'read' }; signatures of the pieces underneath are in src/stralfors/tracking.test.ts.
 * Notes for the developer: a 404 on a tracking operation must surface as "tool failed: not_found" (today a JSON 404 maps to
 * agreement_not_found, a text 404 to route_not_found); history failure after a good lookup is an error, no partial answer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { DOCS, HIST, channel, page, queryOf, rawDoc, rawHistory, receiverCanaries, trackWorld, wrapped } from '../../test/helpers/track.ts';
import { TOO_LARGE_TEXT, ToolInputError } from './tools.ts';
import { createTrackDocument } from './track-tool.ts';

let pki: Pki;
let w: Awaited<ReturnType<typeof trackWorld>> | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const world = async (o: Parameters<typeof trackWorld>[1] = {}) => (w = await trackWorld(pki, o));
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const text = (r: { content: { type: string; text?: string }[] }) => r.content[0]!.text!;
const ONE = 'exactly one of invoiceNumber, extDocumentId or documentId is required';
type Out = { profile: string; documents: { documentId: string; outcome: string; channels: { status: string; outcome: string }[]; history?: { channels: { deliveryDocuments: { events: Record<string, unknown>[] }[] }[] } }[]; hasMore: boolean; nextCursor?: string; checkedAt: string };

describe('tool definition', () => {
  it('is named track_document, access read, no scope, read-only idempotent open-world', async () => {
    const t = createTrackDocument({ clients: new Map() });
    expect(t.spec).toEqual({ name: 'track_document', access: 'read' });
    expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(t.description).toMatch(/hours|days/i);
  });
  it('input bounds (AC-2 SDK validation)', () => {
    const t = createTrackDocument({ clients: new Map() });
    const ok = (a: Record<string, unknown>) => t.inputSchema.safeParse(a).success;
    expect(ok({ invoiceNumber: 'INV-1' })).toBe(true);
    expect(ok({ invoiceNumber: 'x'.repeat(100) })).toBe(true);
    expect(ok({ invoiceNumber: 'x'.repeat(101) })).toBe(false);
    expect(ok({ invoiceNumber: '' })).toBe(false);
    expect(ok({ extDocumentId: 'aZ09-_.' })).toBe(true);
    for (const bad of ['a b', 'a/b', 'a@b', 'ä', '', 'x'.repeat(101)]) expect(ok({ extDocumentId: bad }), bad).toBe(false);
    expect(ok({ extDocumentId: 'x'.repeat(100) })).toBe(true);
    expect(ok({ documentId: 'M8I4' })).toBe(true);
    expect(ok({ documentId: 'x'.repeat(10) })).toBe(true);
    expect(ok({ documentId: 'x'.repeat(11) })).toBe(false);
    expect(ok({ documentId: '' })).toBe(false);
    expect(ok({ invoiceNumber: 'a', cursor: 'x'.repeat(10) })).toBe(true);
    expect(ok({ invoiceNumber: 'a', cursor: 'x'.repeat(11) })).toBe(false);
    expect(ok({ invoiceNumber: 'a', cursor: '' })).toBe(false);
    expect(ok({ invoiceNumber: 'a', channelId: 9 })).toBe(true);
    expect(ok({ invoiceNumber: 'a', channelId: 1.5 })).toBe(false);
    expect(ok({ invoiceNumber: 'a', channelId: '9' })).toBe(false);
    expect(ok({ invoiceNumber: 'a', history: true })).toBe(true);
    expect(ok({ invoiceNumber: 'a', history: 'yes' })).toBe(false);
    expect(ok({ invoiceNumber: 'a', profile: '' })).toBe(false);
  });
  it('the one-of rule is NOT in the schema (it must reach run and the audit)', () => {
    const t = createTrackDocument({ clients: new Map() });
    expect(t.inputSchema.safeParse({}).success).toBe(true);
    expect(t.inputSchema.safeParse({ invoiceNumber: 'a', documentId: 'b' }).success).toBe(true);
  });
  it('output validates against its own schema', async () => {
    const x = await world();
    x.serve(DOCS, 200, page([rawDoc(receiverCanaries())]));
    const r = await x.run({ invoiceNumber: 'INV-1' });
    expect(x.tool.outputSchema.parse(r)).toEqual(r);
  });
});

describe('AC-1 lookup by invoice number', () => {
  it('maps channels, drops all recipient data (keys and values), carries checkedAt, queries only invoiceNumber', async () => {
    const x = await world();
    const c = receiverCanaries();
    x.serve(DOCS, 200, page([rawDoc(c)]));
    const r = (await x.run({ invoiceNumber: 'INV-1' })) as Out;
    expect(r.profile).toBe('b');
    expect(r.documents).toHaveLength(1);
    expect(r.documents[0]).toMatchObject({ documentId: 'M8I4', outcome: 'delivered', channels: [{ channelId: 9, status: 'Delivered', outcome: 'delivered', deliveryTime: '2030-01-03T00:00:00Z' }] });
    const s = JSON.stringify(r);
    for (const v of Object.values(c)) expect(s).not.toContain(v);
    for (const k of ['receiverName', 'receiverAddress', 'receiverPostalCode', 'receiverPostOffice', 'receiverCountryCode', 'eAddress', 'customerNumber', 'subCustomerId', 'documentKeyId', 'fileId', 'additionalDatas', 'vendorNewField']) expect(s, k).not.toContain(k);
    expect(r.checkedAt).toBe('2031-01-02T03:04:05.000Z');
    expect(r.hasMore).toBe(false);
    expect(r).not.toHaveProperty('nextCursor');
    const reqs = x.requests(DOCS);
    expect(reqs.map((q) => q.method)).toEqual(['GET']);
    expect(Object.fromEntries(queryOf(reqs[0]!.url))).toEqual({ invoiceNumber: 'INV-1' });
  });
  it('checkedAt follows the injected clock', async () => {
    const x = await world({ now: () => Date.UTC(2040, 5, 7, 8, 9, 10, 11) });
    x.serve(DOCS, 200, page([]));
    expect(((await x.run({ invoiceNumber: 'a' })) as Out).checkedAt).toBe('2040-06-07T08:09:10.011Z');
  });
  it('an empty list is an answer, not an error', async () => {
    const x = await world();
    x.serve(DOCS, 200, page([]));
    expect(await x.run({ invoiceNumber: 'a' })).toMatchObject({ documents: [], hasMore: false });
  });
  it('the profile argument selects the client', async () => {
    const x = await world();
    x.serve(DOCS, 200, page([]));
    expect(await x.tool.run({ invoiceNumber: 'a', profile: 'a' }, { principal: { userId: 'u', name: 'n', role: 'dev', envs: ['test'] }, env: 'test', allowWrite: false, prodValidateEnabled: false, visible: [] })).toMatchObject({ profile: 'a' });
  });
});

describe('AC-2 exactly one key, before any request', () => {
  it.each<[string, Record<string, unknown>]>([
    ['none', {}],
    ['only flags', { history: true, cursor: 'M8K0' }],
    ['invoiceNumber + extDocumentId', { invoiceNumber: 'a', extDocumentId: 'b' }],
    ['invoiceNumber + documentId', { invoiceNumber: 'a', documentId: 'b' }],
    ['extDocumentId + documentId', { extDocumentId: 'a', documentId: 'b' }],
    ['all three', { invoiceNumber: 'a', extDocumentId: 'b', documentId: 'c' }],
  ])('%s', async (_n, args) => {
    const x = await world();
    const e = await rejection(x.run(args as never));
    expect(e).toBeInstanceOf(ToolInputError);
    expect((e as Error).message).toBe(ONE);
    expect(x.fake.apiRequests).toHaveLength(0);
  });
  it('through the wrapper: fixed text, audited, no request', async () => {
    const x = await world();
    const r = await x.callOnly({});
    expect(r).toMatchObject({ isError: true });
    expect(text(r)).toBe(ONE);
    expect(x.audit.lines().map((l) => [l.tool, l.outcome])).toEqual([['track_document', 'error']]);
    expect(x.fake.apiRequests).toHaveLength(0);
  });
  it('history without documentId and two documents: error, and no history request', async () => {
    const x = await world();
    const c = receiverCanaries();
    x.serve(DOCS, 200, page([rawDoc(c), rawDoc(c, { documentId: 'M8I5' })]));
    const e = await rejection(x.run({ invoiceNumber: 'a', history: true }));
    expect(e).toBeInstanceOf(ToolInputError);
    expect((e as Error).message).toBe('history needs a single document');
    expect(x.fake.apiRequests.filter((q) => q.url.includes('documentinfohistory'))).toHaveLength(0);
  });
  it('history without documentId and no document: same error', async () => {
    const x = await world();
    x.serve(DOCS, 200, page([]));
    expect(((await rejection(x.run({ invoiceNumber: 'a', history: true }))) as Error).message).toBe('history needs a single document');
  });
  it('history with an invoice number and exactly one document uses that document id', async () => {
    const x = await world();
    const c = receiverCanaries();
    x.serve(DOCS, 200, page([rawDoc(c, { documentId: 'Q7Z1' })]));
    x.serve(HIST('Q7Z1'), 200, rawHistory(c));
    const r = (await x.run({ invoiceNumber: 'a', history: true })) as Out;
    expect(r.documents[0]!.history).toBeDefined();
    expect(x.requests(HIST('Q7Z1'))).toHaveLength(1);
  });
});

describe('AC-3 statuses through the tool', () => {
  it('maps five statuses, keeps known status names, masks others', async () => {
    const x = await world();
    const c = receiverCanaries();
    const statuses = ['Verified Delivered', 'rejected', 'Production file created', 'Cancelled', 'SomethingNew'];
    x.serve(DOCS, 200, page(statuses.map((s, i) => rawDoc(c, { documentId: `D${i}`, channels: [channel(s)] }))));
    const r = (await x.run({ invoiceNumber: 'a' })) as Out;
    expect(r.documents.map((d) => [d.channels[0]!.status, d.channels[0]!.outcome])).toEqual([
      ['Verified Delivered', 'delivered'], ['rejected', 'refused'], ['Production file created', 'in_progress'], ['Cancelled', 'failed'], ['other', 'unknown'],
    ]);
  });
});

describe('AC-4 document outcome through the tool', () => {
  it.each<[string[], string]>([
    [['Rejected', 'Delivered'], 'delivered'],
    [['Rejected', 'Registered'], 'in_progress'],
    [['Rejected', 'SomethingNew'], 'in_progress'],
    [['Rejected'], 'refused'],
    [['Cancelled', 'Rejected'], 'refused'],
    [['Cancelled'], 'failed'],
    [[], 'unknown'],
  ])('%j -> %s', async (ss, expected) => {
    const x = await world();
    x.serve(DOCS, 200, page([rawDoc(receiverCanaries(), { channels: ss.map((s) => channel(s)) })]));
    expect(((await x.run({ invoiceNumber: 'a' })) as Out).documents[0]!.outcome).toBe(expected);
  });
});

describe('AC-5 several documents and cursor', () => {
  it('two documents in upstream order', async () => {
    const x = await world();
    const c = receiverCanaries();
    x.serve(DOCS, 200, page([rawDoc(c, { documentId: 'Z9' }), rawDoc(c, { documentId: 'A1' })]));
    expect(((await x.run({ invoiceNumber: 'INV-2' })) as Out).documents.map((d) => d.documentId)).toEqual(['Z9', 'A1']);
  });
  it('lastDocuments false: hasMore and nextCursor is the last documentId', async () => {
    const x = await world();
    const c = receiverCanaries();
    x.serve(DOCS, 200, page([rawDoc(c, { documentId: 'M8J1' }), rawDoc(c, { documentId: 'M8K0' })], false));
    expect(await x.run({ invoiceNumber: 'INV-2' })).toMatchObject({ hasMore: true, nextCursor: 'M8K0' });
  });
  it('lastDocuments true: no more, no cursor', async () => {
    const x = await world();
    x.serve(DOCS, 200, page([rawDoc(receiverCanaries(), { documentId: 'M8K0' })], true));
    const r = await x.run({ invoiceNumber: 'INV-2' });
    expect(r.hasMore).toBe(false);
    expect(r).not.toHaveProperty('nextCursor');
  });
  it('cursor and channelId are passed through', async () => {
    const x = await world();
    x.serve(DOCS, 200, page([]));
    await x.run({ invoiceNumber: 'INV-2', cursor: 'M8K0', channelId: 9 });
    await x.run({ extDocumentId: 'ext-1' });
    await x.run({ documentId: 'M8I4' });
    expect(x.requests(DOCS).map((q) => Object.fromEntries(queryOf(q.url)))).toEqual([
      { invoiceNumber: 'INV-2', lastDocumentId: 'M8K0', channelId: '9' }, { extDocumentId: 'ext-1' }, { documentId: 'M8I4' },
    ]);
  });
});

describe('AC-6 history', () => {
  it('returns events, forces delivered, minimises', async () => {
    const x = await world();
    const c = receiverCanaries();
    x.serve(DOCS, 200, page([rawDoc(c, { channels: [channel('Registered')] })]));
    x.serve(HIST('M8I4'), 200, rawHistory(c));
    const r = (await x.run({ documentId: 'M8I4', history: true })) as Out;
    expect(r.documents[0]!.history!.channels[0]!.deliveryDocuments[0]!.events[0]!.message).toBe('Delivered');
    expect(r.documents[0]!.history).toMatchObject({ status: 'Delivered', arrivalTime: '2030-01-01T00:00:00Z', deliveryDocumentsDelivered: 1, deliveryDocumentsTotal: 1 });
    expect(r.documents[0]!.outcome).toBe('delivered');
    for (const v of Object.values(c)) expect(JSON.stringify(r)).not.toContain(v);
  });
  it('delivered < total does not force delivered', async () => {
    const x = await world();
    const c = receiverCanaries();
    x.serve(DOCS, 200, page([rawDoc(c, { channels: [channel('Registered')] })]));
    x.serve(HIST('M8I4'), 200, rawHistory(c, { deliveryDocumentsDelivered: 1, deliveryDocumentsTotal: 2 }));
    expect(((await x.run({ documentId: 'M8I4', history: true })) as Out).documents[0]!.outcome).toBe('in_progress');
  });
  it('a free-text message keeps the event time and loses the text', async () => {
    const x = await world();
    const c = receiverCanaries();
    x.serve(DOCS, 200, page([rawDoc(c)]));
    const bad = `Delivered to <${c.receiverName}> at <${c.receiverAddress}>`;
    x.serve(HIST('M8I4'), 200, rawHistory(c, { channels: [{ channelId: 9, channelName: 'n', status: 'Delivered', deliveryDocuments: [{ deliveryDocumentId: 'D1', statusHistory: [{ dateTime: '2030-01-02T03:04:05Z', message: bad }] }] }] }));
    const r = (await x.run({ documentId: 'M8I4', history: true })) as Out;
    expect(r.documents[0]!.history!.channels[0]!.deliveryDocuments[0]!.events).toEqual([{ dateTime: '2030-01-02T03:04:05Z' }]);
    expect(JSON.stringify(r)).not.toContain(c.receiverName);
  });
  it.each([[true, true], [{ valueOf: null, toString: null }, { valueOf: null, toString: null }], ['1', '1'], [null, null]])('non-number counters %j never force delivered and never throw', async (d, t) => {
    const x = await world();
    const c = receiverCanaries();
    x.serve(DOCS, 200, page([rawDoc(c, { channels: [channel('Registered')] })]));
    x.serve(HIST('M8I4'), 200, rawHistory(c, { deliveryDocumentsDelivered: d, deliveryDocumentsTotal: t }));
    expect(((await x.run({ documentId: 'M8I4', history: true })) as Out).documents[0]!.outcome).toBe('in_progress');
  });
  it.each([true, false])('a malformed documentId is a typed schema error, not a TypeError (history %s)', async (history) => {
    const x = await world();
    x.serve(DOCS, 200, page([rawDoc(receiverCanaries(), { documentId: { toString: null } })]));
    const e = await rejection(x.run({ invoiceNumber: 'INV-1', history }));
    expect(e).not.toBeInstanceOf(TypeError);
    expect(e).toMatchObject({ kind: 'schema' });
  });
  it('history false (and default): no history request, no history key', async () => {
    const x = await world();
    x.serve(DOCS, 200, page([rawDoc(receiverCanaries())]));
    for (const a of [{ documentId: 'M8I4' }, { documentId: 'M8I4', history: false }]) {
      const r = (await x.run(a)) as Out;
      expect(r.documents[0]).not.toHaveProperty('history');
    }
    expect(x.fake.apiRequests.filter((q) => q.url.includes('documentinfohistory'))).toHaveLength(0);
  });
  it('a history failure after a good lookup is an error, not a partial answer', async () => {
    const x = await world();
    x.serve(DOCS, 200, page([rawDoc(receiverCanaries())]));
    x.serve(HIST('M8I4'), 500, 'boom');
    expect(text(await x.callOnly({ documentId: 'M8I4', history: true }))).toBe('tool failed: upstream');
  });
});

describe('AC-7 bodies and errors', () => {
  it('a string-wrapped text/plain body gives the same result as the plain object', async () => {
    const c = receiverCanaries();
    const x = await world();
    x.serve(DOCS, 200, page([rawDoc(c)]));
    const plain = await x.run({ invoiceNumber: 'a' });
    x.serve(DOCS, 200, wrapped(page([rawDoc(c)])), 'text/plain');
    expect(await x.run({ invoiceNumber: 'a' })).toEqual(plain);
  });
  it('a string-wrapped history body works too', async () => {
    const c = receiverCanaries();
    const x = await world();
    x.serve(DOCS, 200, page([rawDoc(c)]));
    x.serve(HIST('M8I4'), 200, wrapped(rawHistory(c)), 'text/plain');
    expect(((await x.run({ documentId: 'M8I4', history: true })) as Out).documents[0]!.history).toBeDefined();
  });
  it.each<[number, unknown, string]>([
    [404, { message: 'UPSTREAM-TEXT-CANARY', compositeFault: { faults: [] } }, 'tool failed: not_found'],
    [400, { message: 'UPSTREAM-TEXT-CANARY' }, 'tool failed: bad_request'],
    [401, { message: 'UPSTREAM-TEXT-CANARY' }, 'tool failed: auth'],
    [403, { message: 'UPSTREAM-TEXT-CANARY' }, 'tool failed: forbidden'],
    [500, 'UPSTREAM-TEXT-CANARY', 'tool failed: upstream'],
    [503, 'UPSTREAM-TEXT-CANARY', 'tool failed: upstream'],
  ])('upstream %i -> %s, no upstream text', async (status, body, expected) => {
    const x = await world();
    x.serve(DOCS, status, body);
    const r = await x.callOnly({ invoiceNumber: 'INV-1' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(expected);
    expect(JSON.stringify(r)).not.toContain('UPSTREAM-TEXT-CANARY');
  });
  it('a JSON 404 is audited as not_found, not bad_input', async () => {
    const x = await world();
    x.serve(DOCS, 404, { message: 'x', compositeFault: { faults: [] } });
    await x.callOnly({ invoiceNumber: 'INV-1' });
    expect(x.audit.lines()[0]).toMatchObject({ outcome: 'error', reason: 'not_found' });
  });
  it('the gateway text 404 (no such route) is not reported as not_found', async () => {
    const x = await world(); // no route served: 404 text/plain
    expect(text(await x.callOnly({ invoiceNumber: 'INV-1' }))).toBe('tool failed: route_not_found');
  });
  it('a 404 on the history call is not_found too', async () => {
    const x = await world();
    x.serve(DOCS, 200, page([rawDoc(receiverCanaries())]));
    x.serve(HIST('M8I4'), 404, { message: 'x' });
    expect(text(await x.callOnly({ documentId: 'M8I4', history: true }))).toBe('tool failed: not_found');
  });
  it('output over the cap gives the existing too-large error', async () => {
    const x = await world();
    const c = receiverCanaries();
    x.serve(DOCS, 200, page(Array.from({ length: 30 }, (_v, i) => rawDoc(c, { documentId: `D${i}` }))));
    const r = await x.callOnly({ invoiceNumber: 'a' }, { maxOutputBytes: 1024 });
    expect(r).toMatchObject({ isError: true });
    expect(text(r)).toBe(TOO_LARGE_TEXT);
    const ok = await x.callOnly({ invoiceNumber: 'a' });
    expect(ok.isError).toBeFalsy();
  });
});

describe('AC-9 canaries stay out of logs, spans and audit', () => {
  const key = { invoice: 'INV-CANARY-7f3a', ext: 'ext-canary-7f3a', doc: 'DCAN7F3A', cursor: 'CUR7F3A' };
  const all = (x: NonNullable<typeof w>) => x.log.text() + x.audit.text();
  const run = async (kind: 'ok' | 'history' | 'not_found' | 'upstream' | 'input') => {
    const x = await world();
    const c = receiverCanaries();
    if (kind === 'not_found') x.serve(DOCS, 404, { message: `no ${key.invoice} ${c.receiverName}` });
    else if (kind === 'upstream') x.serve(DOCS, 500, `${key.invoice} ${c.receiverName}`);
    else x.serve(DOCS, 200, page([rawDoc(c, { documentId: key.doc, invoiceNumber: key.invoice, extDocumentId: key.ext })], false));
    x.serve(HIST(key.doc), 200, rawHistory(c));
    const args = kind === 'history' ? { documentId: key.doc, history: true, cursor: key.cursor } : kind === 'input' ? { invoiceNumber: key.invoice, extDocumentId: key.ext } : { invoiceNumber: key.invoice, cursor: key.cursor };
    const r = await x.callOnly(args as never);
    return { x, c, r };
  };
  it.each(['ok', 'history', 'not_found', 'upstream', 'input'] as const)('%s', async (kind) => {
    const { x, c, r } = await run(kind);
    const s = all(x);
    for (const v of [...Object.values(key), ...Object.values(c)]) expect(s, `${kind} ${v}`).not.toContain(v);
    const lines = x.audit.lines().filter((l) => l.tool === 'track_document');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.outcome).toBe(kind === 'ok' || kind === 'history' ? 'allowed' : 'error');
    if (kind !== 'ok' && kind !== 'history') expect(JSON.stringify(r)).not.toMatch(/CANARY|canary/);
  });
});

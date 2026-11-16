// Fixtures for track_document: routes-based fake Track & Trace API, synthetic documents with every receiver field filled by a run-time canary.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient } from '../../src/stralfors/index.ts';
import { json, memoryLogger, startFakeApi } from './api.ts';
import { loadConfig, twoProfiles } from './boot.ts';
import type { Pki } from './mtls.ts';
import { principal, sink } from './server.ts';
import { callTool, type ToolContext } from '../../src/server/tools.ts';
import { createTrackDocument } from '../../src/server/track-tool.ts';

export const TRACK = '/rest/outputmanagement/tracktrace/v1';
export const DOCS = `${TRACK}/document/documents`;
export const HIST = (id: string) => `${TRACK}/document/${id}/documentinfohistory`;
type Reply = (req: IncomingMessage, res: ServerResponse) => void;

const hex = () => randomBytes(5).toString('hex');
/** One canary per receiver-side field, built at run time. Tests assert the VALUES are absent from every output and log. */
export const receiverCanaries = () => ({
  receiverName: `NAME-CANARY-${hex()}`, receiverAddress: `ADDR-CANARY-${hex()}`, receiverPostalCode: `ZIP-CANARY-${hex()}`,
  receiverPostOffice: `POST-CANARY-${hex()}`, receiverCountryCode: `CTRY-CANARY-${hex()}`, eAddress: `EADDR-CANARY-${hex()}`,
  customerNumber: `CUST-CANARY-${hex()}`, subCustomerId: `SUB-CANARY-${hex()}`, documentKeyId: `KEY-CANARY-${hex()}`,
  fileId: `FILE-CANARY-${hex()}`, additionalValue: `ADD-CANARY-${hex()}`, comment: `COMMENT-CANARY-${hex()}`,
});
export type Canaries = ReturnType<typeof receiverCanaries>;

export const channel = (status: string, extra: Record<string, unknown> = {}, c?: Canaries) => ({
  channelId: 9, channelName: 'eBrev/WeMail', status, documents: 1, pages: 2,
  statusComments: [{ status, dateTime: '2030-01-02T03:04:05Z', comment: c?.comment ?? 'c', paymentMethod: 'Card' }],
  additionalDatas: [{ key: 'k', value: c?.additionalValue ?? 'v' }],
  ...extra,
});
/** A raw upstream document with every receiver field filled. */
export const rawDoc = (c: Canaries, o: Record<string, unknown> = {}) => ({
  documentId: 'M8I4', extDocumentId: 'ext-1', invoiceNumber: 'INV-1', lastChange: '2030-01-02T03:04:05Z',
  customerNumber: c.customerNumber, subCustomerId: c.subCustomerId, receiverName: c.receiverName, receiverAddress: c.receiverAddress,
  receiverPostalCode: c.receiverPostalCode, receiverPostOffice: c.receiverPostOffice, receiverCountryCode: c.receiverCountryCode,
  eAddress: c.eAddress, documentKeyId: c.documentKeyId, fileId: c.fileId, vendorNewField: c.fileId,
  channels: [channel('Delivered', { deliveryTime: '2030-01-03T00:00:00Z' }, c)],
  ...o,
});
export const rawHistory = (c: Canaries, o: Record<string, unknown> = {}) => ({
  status: 'Delivered', arrivalTime: '2030-01-01T00:00:00Z', deliveryDocumentsDelivered: 1, deliveryDocumentsTotal: 1, receiverName: c.receiverName,
  channels: [{
    channelId: 9, channelName: 'eBrev/WeMail', status: 'Delivered', receiverAddress: c.receiverAddress,
    deliveryDocuments: [{ deliveryDocumentId: 'D1', receiverName: c.receiverName, statusHistory: [{ dateTime: '2030-01-02T03:04:05Z', message: 'Delivered' }] }],
  }],
  ...o,
});
export const page = (documents: unknown[], lastDocuments = true) => ({ documents, lastDocuments });
export const queryOf = (url: string) => new URL(url, 'https://x').searchParams;
export const wrapped = (o: unknown) => JSON.stringify(JSON.stringify(o)); // text/plain body: a JSON string wrapping the object

export const ctx = (): ToolContext => ({ principal: principal('dev', ['test']), env: 'test', allowWrite: false, prodValidateEnabled: false, visible: [] });

export interface TrackOpts {
  env?: Record<string, string | undefined>;
  now?: () => number;
}
/** Profile b is the default; profile a is reachable by `profile`. Unmapped routes answer the gateway 404 text. */
export async function trackWorld(pki: Pki, o: TrackOpts = {}) {
  const routes: Record<string, Reply> = {};
  const fake = await startFakeApi({ pki, api: (req, res) => (routes[req.url!.split('?')[0]!] ?? ((_q, s) => json(s, 404, 'No Mapping Rule matched', 'text/plain')))(req, res) });
  const tp = twoProfiles(pki, o.env);
  const config = loadConfig(tp.env);
  const mem = memoryLogger();
  const mk = (ids: string[]) => new Map(ids.map((id) => [id, createClient({ config, profileId: id, ca: pki.ca, baseUrl: fake.url, logger: mem.logger })]));
  const all = mk(Object.keys(config.profiles));
  const now = o.now ?? (() => Date.UTC(2031, 0, 2, 3, 4, 5));
  const tool = createTrackDocument({ clients: all, now });
  const only = createTrackDocument({ clients: new Map([['b', all.get('b')!]]), now });
  type Args = Parameters<typeof tool.run>[0];
  const audit = sink();
  const deps = { env: 'test' as const, allowWrite: false, prodValidateEnabled: false, audit: audit.audit };
  const requests = (path: string) => fake.apiRequests.filter((x) => x.url.split('?')[0] === path);
  return {
    ...tp, config, clients: all, fake, routes, tool, requests, audit, log: mem, now,
    /** serve a fixed reply on a path */
    serve: (path: string, status: number, body: unknown, type = 'application/json') => void (routes[path] = (_q, res) => json(res, status, body, type)),
    /** profile b alone, direct */
    run: (args: Args) => only.run(args, ctx()),
    /** through the registry wrapper: sanitised text and audit line */
    callOnly: (args: Args, extra: { maxOutputBytes?: number } = {}) => callTool(only as never, args, principal('dev', ['test']), { ...deps, ...extra }),
    close: async () => {
      try {
        await Promise.allSettled([...all.values()].map((c) => c.close()));
      } finally {
        await fake.close();
      }
    },
  };
}

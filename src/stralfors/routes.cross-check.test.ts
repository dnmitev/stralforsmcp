// R-10 (AEGIS D-003): vendor route knowledge lives in four places: operations(), the guard (isAllowed), the client's path masking and the audit route words.
// This test calls EVERY operation and checks the other three against one table, so a new operation without a row, or a stale site, fails here.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fromBlocked } from '../audit/audit.ts';
import { json, memoryLogger, startFakeApi, testClient, type FakeApi } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { isAllowed } from './http.ts';
import { operations } from './operations.ts';

const ID = {
  uuid: randomUUID(),
  digits: '1234567890123',
  shortDoc: 'Abc123XYZ9', // a tracking document id: short, alphanumeric, not caught by the id regex
  corr: 'corr-ab12cd', // a vendor-chosen correlation id: masked by position only
  consignment: 'cons-0123456789',
  invoiceNo: '7654321',
};
const SAMPLE_IDS = Object.values(ID);

interface Call { method: string; path: string; query: Record<string, string>; operation?: string }
function record() {
  const calls: Call[] = [];
  const core = {
    get: async (path: string, o: { query?: Record<string, string>; operation?: string } = {}) => void calls.push({ method: 'GET', path, query: o.query ?? {}, operation: o.operation }),
    post: async (path: string, _b: unknown, o: { query?: Record<string, string>; operation?: string } = {}) => void calls.push({ method: 'POST', path, query: o.query ?? {}, operation: o.operation }),
    put: async (path: string, _b: unknown, o: { query?: Record<string, string>; operation?: string } = {}) => void calls.push({ method: 'PUT', path, query: o.query ?? {}, operation: o.operation }),
  };
  return { calls, core, ops: operations(core as never) };
}

// operation -> what each site must say. `audit` is the tool string the audit log would carry for a blocked call on that path.
// Words the audit does not know (tracktrace, channellookup, lookup, documents, documentinfohistory) are masked to `*`: over-masking, never a leak (deferred finding in the 05-04c summary).
const TABLE: Record<string, { method: string; prod: boolean; prodValidate: boolean; test: boolean; audit: string }> = {
  apiInfo: { method: 'GET', prod: true, prodValidate: true, test: true, audit: 'DELETE /rest/outputmanagement/apiomni/v2/apiinfo' },
  healthV1: { method: 'GET', prod: true, prodValidate: true, test: true, audit: 'DELETE /rest/outputmanagement/apiomni/v1/manage/health' },
  channels: { method: 'GET', prod: true, prodValidate: true, test: true, audit: 'DELETE /rest/outputmanagement/apiomni/v2/invoices/channels' },
  templates: { method: 'GET', prod: true, prodValidate: true, test: true, audit: 'DELETE /rest/outputmanagement/apiomni/v2/invoices/templates' },
  rules: { method: 'GET', prod: true, prodValidate: true, test: true, audit: 'DELETE /rest/outputmanagement/apiomni/v2/invoices/rules' },
  documentExample: { method: 'GET', prod: true, prodValidate: true, test: true, audit: 'DELETE /rest/outputmanagement/apiomni/v2/invoices/document' },
  trackDocuments: { method: 'GET', prod: true, prodValidate: true, test: true, audit: 'DELETE /rest/outputmanagement/*/v1/document/*' },
  trackHistory: { method: 'GET', prod: true, prodValidate: true, test: true, audit: 'DELETE /rest/outputmanagement/*/v1/document/*/*' },
  channelLookup: { method: 'POST', prod: false, prodValidate: false, test: true, audit: 'DELETE /rest/outputmanagement/*/v1/*' },
  channelLookupResult: { method: 'GET', prod: false, prodValidate: false, test: true, audit: 'DELETE /rest/outputmanagement/*/v1/*/*' },
  validateInvoice: { method: 'PUT', prod: false, prodValidate: true, test: true, audit: 'DELETE /rest/outputmanagement/apiomni/v2/invoices/validate' },
};

const validBody = {
  actionId: ID.uuid, consignmentId: ID.consignment,
  document: { documentHeader: { n: ID.invoiceNo }, invoice: { n: ID.invoiceNo } },
};
function callAll() {
  const { calls, ops } = record();
  const done: Promise<unknown>[] = [
    ops.apiInfo(), ops.healthV1(), ops.channels(ID.uuid), ops.templates(), ops.rules('EDI', { templateStandardId: 0 }),
    ops.documentExample({ channels: ['EDI'] }), ops.trackDocuments({ invoiceNumber: ID.invoiceNo, documentId: ID.shortDoc, channelId: 12345678 }),
    ops.trackHistory(ID.shortDoc), ops.channelLookup({ channels: ['EDI'], candidates: [ID.digits] }), ops.channelLookupResult(ID.corr), ops.validateInvoice(validBody),
  ];
  return { calls, done: Promise.all(done), names: Object.keys(ops) };
}

let pki: Pki;
let fake: FakeApi | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('route cross-check', () => {
  it('the table has a row for every operation and nothing else', () => {
    expect(Object.keys(TABLE).sort()).toEqual(Object.keys(record().ops).sort());
  });

  it('every operation was exercised once, by its own operation name', async () => {
    const { calls, done, names } = callAll();
    await done;
    expect(calls.map((c) => c.operation).sort()).toEqual([...names].sort());
  });

  it('guard: each operation is allowed or denied exactly as the table says', async () => {
    const { calls, done } = callAll();
    await done;
    for (const c of calls) {
      const row = TABLE[c.operation!]!;
      const target = c.path + (Object.keys(c.query).length ? `?${new URLSearchParams(c.query)}` : '');
      expect(c.method, c.operation).toBe(row.method);
      expect(isAllowed({ env: 'prod', allowWrite: false, prodValidateEnabled: false }, c.method, target), `prod ${c.operation}`).toBe(row.prod);
      expect(isAllowed({ env: 'prod', allowWrite: false, prodValidateEnabled: true }, c.method, target), `prod+validate ${c.operation}`).toBe(row.prodValidate);
      expect(isAllowed({ env: 'test', allowWrite: false, prodValidateEnabled: false }, c.method, target), `test ${c.operation}`).toBe(row.test);
    }
  });

  it('masking and audit: no sample id survives in the path template, log, blocked event or audit tool; the audit string is the pinned one', async () => {
    const { calls, done } = callAll();
    await done;
    fake = await startFakeApi({ pki, api: (_r, res) => json(res, 200, {}) });
    for (const c of calls) {
      const blocked: { profile: string; method: string; pathTemplate: string }[] = [];
      const mem = memoryLogger();
      const { client } = testClient(pki, fake, { extra: { STRALFORS_ENV: 'prod' }, logger: mem.logger, onBlocked: (e) => void blocked.push(e) });
      // DELETE is blocked in PROD on every route, before any I/O: it shows what the client prints for this exact path and query
      await expect(client.delete(c.path, { query: c.query } as never)).rejects.toMatchObject({ kind: 'write_blocked' });
      await client.close();
      expect(blocked).toHaveLength(1);
      const audit = fromBlocked(blocked[0]!).tool;
      const seen = JSON.stringify({ blocked, log: mem.text(), audit });
      for (const id of SAMPLE_IDS) expect(seen, `${c.operation} leaked ${id}`).not.toContain(id);
      expect(audit, c.operation).toBe(TABLE[c.operation!]!.audit);
    }
    expect(fake.apiRequests).toHaveLength(0);
  });
});

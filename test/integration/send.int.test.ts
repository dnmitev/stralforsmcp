// 06-02 Task 3: send_invoice end to end over mTLS against WireMock (ADR 0028). Each stub path must see exactly one request: no replay, no retry.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrationEnabled } from './docker.ts';
import { startWiremock, type WiremockStack } from './wiremock.ts';
import { bootWorld, ok, type World } from './world.ts';

const enabled = await integrationEnabled();
const SEND = '/rest/outputmanagement/apiomni/v2/invoices/true';
const CANARY = /CANARY-[A-Z0-9-]+/;
const doc = { documentHeader: { timeStamp: '2030-01-02T03:04:05Z', channelPriority: ['Custom'] }, invoice: { id: 'INV-IT-SEND-1' } };

describe.skipIf(!enabled)('send_invoice (TEST, write flag on)', () => {
  let wm: WiremockStack;
  let w: World;
  beforeAll(async () => {
    wm = await startWiremock();
    w = await bootWorld(wm, { STRALFORS_ALLOW_WRITE: 'true', STRALFORS_TIMEOUT_MS: '1500' });
  });
  afterAll(async () => {
    await w?.close();
    await wm?.stop();
  });
  const sends = async (cid: string) => (await wm.journal()).filter((r) => r.url === SEND && r.method === 'POST' && JSON.parse(r.body).consignmentId === cid);
  const send = (consignmentId: string) => w.call('send_invoice', { agreement: 'main', consignmentId, document: doc });

  it('is listed for a caller with the write scope', async () => {
    expect((await w.client.listTools()).tools.map((t) => t.name)).toContain('send_invoice');
  });
  it.each([
    ['it-send-ok-000001', 'sent'],
    ['it-send-faults-01', 'rejected'],
    ['it-send-dup-00001', 'rejected'],
    ['it-send-5xx-00001', 'unknown'],
    ['it-send-slow-0001', 'unknown'],
  ])('%s: outcome %s after exactly one POST, no vendor text in the answer', async (cid, outcome) => {
    const r = await send(cid);
    expect(ok(r)).toMatchObject({ outcome, consignmentId: cid });
    expect(JSON.stringify(r)).not.toMatch(CANARY);
    expect(await sends(cid)).toHaveLength(1);
    const sent = (await sends(cid))[0]!;
    expect(JSON.parse(sent.body)).toMatchObject({ consignmentId: cid, document: doc });
  });
  it('a 409 carries the duplicate finding; 400 faults are mapped to findings', async () => {
    expect(ok(await send('it-send-dup-00001')).findings).toEqual([expect.objectContaining({ kind: 'duplicate', path: 'consignmentId' })]);
    expect(ok(await send('it-send-faults-01')).findings.length).toBeGreaterThan(0);
  });
  it('the audit and the logs carry the outcome, never the consignmentId, document or vendor text', async () => {
    await send('it-send-ok-000001');
    const lines = w.audit.lines().filter((l) => l.tool === 'send_invoice');
    expect(lines.map((l) => l.reason)).toContain('sent');
    const text = w.audit.text() + w.logs();
    for (const v of ['it-send-ok-000001', 'INV-IT-SEND-1', ...w.secrets()]) expect(text).not.toContain(v);
    expect(text).not.toMatch(CANARY);
  });
});

describe.skipIf(!enabled)('send_invoice without the write flag', () => {
  let wm: WiremockStack;
  let w: World;
  beforeAll(async () => {
    wm = await startWiremock();
    w = await bootWorld(wm);
  });
  afterAll(async () => {
    await w?.close();
    await wm?.stop();
  });
  it('is not listed, a call fails, and nothing reaches the send route', async () => {
    expect((await w.client.listTools()).tools.map((t) => t.name)).not.toContain('send_invoice');
    const failed = await w.call('send_invoice', { agreement: 'main', consignmentId: 'it-send-ok-000001', document: doc }).then((r) => r.isError === true, () => true); // the SDK refuses a tool that was never registered
    expect(failed).toBe(true);
    expect((await wm.journal()).filter((q) => q.url === SEND)).toHaveLength(0);
  });
});

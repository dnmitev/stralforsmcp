// AC-5: canaries sit in every stub field that must not surface; none may reach a tool result, log line, span, metric or audit line.
// The canaries are harvested from the stub files themselves, so a new stub field is covered the moment it carries one.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dump } from '../helpers/telemetry.ts';
import { integrationEnabled } from './docker.ts';
import { startWiremock, type WiremockStack } from './wiremock.ts';
import { bootWorld, ok, type World } from './world.ts';

const enabled = await integrationEnabled();
const dir = fileURLToPath(new URL('./mappings', import.meta.url));
const stubText = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
const CANARIES = [...new Set(stubText.match(/CANARY-[A-Z0-9]+(?:-[A-Z0-9]+)*/g) ?? [])];

describe.skipIf(!enabled)('privacy on the container path', () => {
  let wm: WiremockStack;
  let w: World;
  const results: unknown[] = [];
  beforeAll(async () => {
    wm = await startWiremock();
    w = await bootWorld(wm);
    const doc = (channel: string) => ({ documentHeader: { timeStamp: '2030-01-02T03:04:05Z', channelPriority: [channel] }, invoice: { id: 'INV-IT-1' } });
    const calls: [string, Record<string, unknown>][] = [
      ['list_channels', {}], ['list_channels', { agreement: 'main' }],
      ['get_rules', { channel: 'eBrevWeMail' }], ['get_rules', { channel: 'eInvoice', limit: 200 }],
      ['get_example_invoice', { channels: ['EDI'] }],
      ...['it-valid-000001', 'it-header-fault-1', 'it-template-fault-1', 'it-engine-fault-1', 'it-problem-details-1'].map((c): [string, Record<string, unknown>] => ['validate_invoice', { agreement: 'main', consignmentId: c, document: doc('EDI') }]),
      ['validate_invoice', { agreement: 'gone', consignmentId: 'it-valid-000001', document: doc('EDI') }],
      ['track_document', { invoiceNumber: 'INV-LIST-1' }], ['track_document', { documentId: 'M8I4', history: true }], ['track_document', { extDocumentId: 'ext-wrapped' }],
      ['track_document', { invoiceNumber: 'INV-NONE' }],
      ...['ERR-GATEWAY-404', 'ERR-AGREEMENT-404', 'ERR-PROBLEM-400', 'ERR-UNAUTHORIZED-401', 'ERR-FORBIDDEN-403', 'ERR-RATE-429', 'ERR-SERVER-500', 'ERR-RESET'].map((k): [string, Record<string, unknown>] => ['track_document', { invoiceNumber: k }]),
    ];
    for (const [name, args] of calls) results.push(await w.call(name, args));
  });
  afterAll(async () => {
    await w?.close();
    await wm?.stop();
  });

  it('finds a meaningful number of canaries in the stubs', () => {
    expect(CANARIES.length).toBeGreaterThanOrEqual(25);
  });
  it('the calls really returned data (the canaries were in play)', () => {
    expect(results.filter((r) => !(r as { isError?: boolean }).isError).length).toBeGreaterThanOrEqual(13);
  });
  it('no canary in any tool result', () => {
    const all = JSON.stringify(results);
    for (const c of CANARIES) expect(all, c).not.toContain(c);
  });
  it('no canary in any server log line, span, metric or audit line', async () => {
    const sinks = [w.logs(), w.audit.text(), dump(w.tel.spans()), await w.tel.text()].join('\n');
    expect(sinks.length).toBeGreaterThan(0);
    for (const c of CANARIES) expect(sinks, c).not.toContain(c);
  });
  it('no run-time secret, token or agreement id in any sink or result', async () => {
    const sinks = [JSON.stringify(results), w.logs(), w.audit.text(), dump(w.tel.spans()), await w.tel.text()].join('\n');
    for (const s of w.secrets()) expect(sinks).not.toContain(s);
  });
  it('the documented pass-through rule metadata does arrive (positive control)', async () => {
    const r = ok(await w.call('get_rules', { channel: 'eInvoice', limit: 200 }));
    expect(JSON.stringify(r)).toContain('PASSTHRU-OPT');
  });
});

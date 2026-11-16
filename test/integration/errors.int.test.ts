// AC-4: every vendor error shape maps to the existing typed kind, with no upstream text in the error, tool result, log or audit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { createClient, loadConfig, type StralforsClient } from '../../src/stralfors/index.ts';
import { makeEnv, memoryLogger } from '../helpers/api.ts';
import { integrationEnabled } from './docker.ts';
import { startWiremock, type WiremockStack } from './wiremock.ts';
import { bootWorld, errText, type World } from './world.ts';

const enabled = await integrationEnabled();

// [stub key, client kind, status, tool text]
const SHAPES: [string, string, number | undefined, string][] = [
  ['ERR-GATEWAY-404', 'route_not_found', 404, 'tool failed: route_not_found'],
  ['ERR-AGREEMENT-404', 'agreement_not_found', 404, 'tool failed: not_found'], // track_document maps a JSON 404 to its own text
  ['ERR-PROBLEM-400', 'bad_request', 400, 'tool failed: bad_request'],
  ['ERR-UNAUTHORIZED-401', 'auth', 401, 'tool failed: auth'],
  ['ERR-FORBIDDEN-403', 'forbidden', 403, 'tool failed: forbidden'],
  ['ERR-RATE-429', 'rate_limited', 429, 'tool failed: rate_limited'],
  ['ERR-SERVER-500', 'upstream', 500, 'tool failed: upstream'],
  ['ERR-RESET', 'upstream', undefined, 'tool failed: upstream'], // a connection closed mid-response, after the agent has proven the handshake
];
const CANARY = /CANARY-[A-Z0-9-]+/;

describe.skipIf(!enabled)('vendor error shapes', () => {
  let wm: WiremockStack;
  let w: World;
  let client: StralforsClient;
  const mem = memoryLogger();
  beforeAll(async () => {
    wm = await startWiremock();
    w = await bootWorld(wm);
    const config = loadConfig(makeEnv(wm.pki).env);
    client = createClient({ config, profileId: 'a', ca: wm.pki.ca, baseUrl: wm.httpsBase, logger: mem.logger });
    await client.apiInfo(); // proves the handshake, so a later reset counts as upstream rather than TLS
  });
  afterAll(async () => {
    await client?.close();
    await w?.close();
    await wm?.stop();
  });

  it.each(SHAPES)('%s surfaces as kind %s (client)', async (key, kind, status) => {
    const e = (await client.trackDocuments({ invoiceNumber: key }).then(() => undefined, (x: unknown) => x)) as Error & { kind: string; status?: number; retryAfterMs?: number };
    expect(e).toMatchObject({ kind, status });
    if (kind === 'rate_limited') expect(e.retryAfterMs).toBe(7000);
    for (const text of [e.message, JSON.stringify(e), inspect(e)]) expect(text).not.toMatch(CANARY);
    expect(e.message).toMatch(/^(HTTP \d{3}: [a-z ]+|bad request: \d+ field\(s\)|network error \([A-Z_]+\))$/);
  });

  it.each(SHAPES)('%s surfaces as "%s" text through the tool (%#)', async (key, _kind, _s, text) => {
    const r = await w.call('track_document', { invoiceNumber: key });
    expect(errText(r)).toBe(text);
    expect(JSON.stringify(r)).not.toMatch(CANARY);
  });

  it('a 400 from the dry run and a 404 agreement keep their own fixed shapes', async () => {
    const doc = { documentHeader: { timeStamp: '2030-01-02T03:04:05Z', channelPriority: ['Custom'] }, invoice: { id: 'INV-IT-1' } };
    const bad = await w.call('validate_invoice', { agreement: 'main', consignmentId: 'it-problem-details-1', document: doc });
    expect(bad.isError).toBeFalsy();
    expect(JSON.stringify(bad)).not.toMatch(CANARY);
    expect(errText(await w.call('validate_invoice', { agreement: 'gone', consignmentId: 'it-valid-000001', document: doc }))).toBe('agreement not found for this profile');
  });

  it('nothing from any error body reached the client log, the server log or the audit', () => {
    for (const text of [mem.text(), w.logs(), w.audit.text()]) expect(text).not.toMatch(CANARY);
    const reasons = w.audit.lines().filter((l) => l.tool === 'track_document').map((l) => l.reason);
    expect(reasons).toEqual(expect.arrayContaining(['route_not_found', 'auth', 'forbidden', 'rate_limited', 'upstream']));
  });
});

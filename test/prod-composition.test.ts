// R-32: the PROD write guard verified through ALL layers at once: start() in PROD mode -> auth -> policy -> tool registry -> real client -> mTLS fake API.
// Each layer has its own stub-based tests; this one fails if the wiring between them lets a method or path through.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/stralfors/index.ts';
import { connect } from './helpers/server.ts';
import { useStartWorld } from './helpers/start.ts';

const W = useStartWorld();
const A = '/rest/outputmanagement/apiomni';

// Literal allowlist of what the fake upstream may ever see in PROD (path without query, method). Not derived from the guard under test.
const ALLOWED = (validate: boolean) => (r: { method: string; url: string }) => {
  const path = r.url.split('?')[0]!;
  if (r.method === 'GET') return [`${A}/v2/invoices/channels`, `${A}/v2/invoices/rules`, `${A}/v2/invoices/document`, `${A}/v2/invoices/templates`, `${A}/v2/apiinfo`, `${A}/v1/manage/health`, '/rest/outputmanagement/tracktrace/v1/document/documents'].includes(path) || /^\/rest\/outputmanagement\/tracktrace\/v1\/document\/[A-Za-z0-9]{1,10}\/documentinfohistory$/.test(path);
  return validate && r.method === 'PUT' && path === `${A}/v2/invoices/validate` && r.url.split('?')[1] === 'test=true';
};

// One minimal valid call per tool. A visible tool without a row fails the test, so a new tool must be added here deliberately.
// Each call also names the upstream request it must produce (method + path regex), or null when the tool must stay local.
type Row = { args: Record<string, unknown>; upstream: [string, RegExp] | null };
const ARGS: Record<string, Row[]> = {
  whoami: [{ args: {}, upstream: null }],
  list_channels: [{ args: { profile: 'a' }, upstream: ['GET', /\/v2\/invoices\/channels$/] }],
  get_rules: [{ args: { profile: 'a', channel: 'EDI' }, upstream: ['GET', /\/v2\/invoices\/rules$/] }],
  get_example_invoice: [{ args: { profile: 'a', channels: ['EDI'] }, upstream: ['GET', /\/v2\/invoices\/document$/] }],
  track_document: [
    { args: { profile: 'a', invoiceNumber: '1234567' }, upstream: ['GET', /\/tracktrace\/v1\/document\/documents$/] },
    // the history leg needs a documents page that answers; this fake only serves channels, so it stops at the lookup (history paths are pinned by the route tests)
    { args: { profile: 'a', extDocumentId: 'ext-1' }, upstream: ['GET', /\/tracktrace\/v1\/document\/documents$/] },
  ],
  search_docs: [{ args: { query: 'channel' }, upstream: null }],
  validate_invoice: [{ args: { profile: 'a', agreement: 'billing', document: { documentHeader: { channelPriority: ['EDI'] }, invoice: {} } }, upstream: ['PUT', /\/v2\/invoices\/validate$/] }],
};

describe.each([[false], [true]])('PROD, validate flag %s', (validate) => {
  it('every visible tool, called with valid input, reaches upstream only through allowed methods and paths', async () => {
    const env = W.mcpEnv({ STRALFORS_ENV: 'prod', STRALFORS_PROD_VALIDATE_ENABLED: validate ? 'true' : undefined });
    const b = await W.boot(env);
    const A1 = W.state.f.raw.tA;
    const client = await connect('modern', W.bearer(b.s.port, A1));
    const visible = (await client.listTools()).tools.map((t) => t.name).sort();

    // policy: no write or lookup tool in PROD; the validate tool only with the flag
    // the complete list, so a read tool that vanishes from PROD fails here instead of silently dropping its upstream checks below
    expect(visible).toEqual(['get_example_invoice', 'get_rules', 'list_channels', 'search_docs', 'track_document', ...(validate ? ['validate_invoice'] : []), 'whoami'].sort());
    for (const name of visible) expect(ARGS[name], `no call row for visible tool ${name}`).toBeDefined();

    const before = W.api.fake.apiRequests.length;
    for (const name of visible) {
      for (const { args, upstream } of ARGS[name]!) {
        const mark = W.api.fake.apiRequests.length;
        await client.callTool({ name, arguments: args });
        const fresh = W.api.fake.apiRequests.slice(mark);
        // a tool error resolves as an isError result, so assert the request itself: each call must hit exactly the route it is meant to
        if (upstream === null) expect(fresh, `${name} stays local`).toEqual([]);
        else expect(fresh.some((r) => r.method === upstream[0] && upstream[1].test(r.url.split('?')[0]!)), `${name} reached ${upstream[0]} ${upstream[1]}`).toBe(true);
      }
    }
    const seen = W.api.fake.apiRequests.slice(before);
    expect(seen.length, 'the tools really reached the fake upstream').toBeGreaterThan(0);
    const bad = seen.filter((r) => !ALLOWED(validate)(r));
    expect(bad.map((r) => `${r.method} ${r.url.split('?')[0]}`)).toEqual([]);
    expect(seen.some((r) => r.method === 'PUT')).toBe(validate);
    await client.close();
  });

  it('a write forced through the same client configuration never reaches upstream', async () => {
    const env = W.mcpEnv({ STRALFORS_ENV: 'prod', STRALFORS_PROD_VALIDATE_ENABLED: validate ? 'true' : undefined });
    const client = W.real({ config: loadConfig(env), profileId: 'a' });
    const before = W.api.fake.apiRequests.length;
    const attempts: [string, () => Promise<unknown>][] = [
      ['POST invoices', () => client.post(`${A}/v2/invoices/true`, { x: 1 })],
      ['POST invoices (test flag)', () => client.post(`${A}/v2/invoices/false`, { x: 1 })],
      ['POST lookup', () => client.post('/rest/outputmanagement/channellookup/v1/lookup', { channels: ['EDI'], candidates: ['1'] })],
      ['PUT validate, no test flag', () => client.put(`${A}/v2/invoices/validate`, {})],
      ['PUT validate, test=false', () => client.put(`${A}/v2/invoices/validate`, {}, { query: { test: 'false' } })],
      ['DELETE channels', () => client.delete(`${A}/v2/invoices/channels`)],
    ];
    for (const [label, run] of attempts) await expect(run(), label).rejects.toMatchObject({ kind: 'write_blocked' });
    expect(W.api.fake.apiRequests.length).toBe(before);
    await client.close();
  });
});

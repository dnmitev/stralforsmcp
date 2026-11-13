/* get_example_invoice against the in-process mTLS fake. The example is a synthetic ~25 KB object. */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXAMPLE_NOTES, createGetExampleInvoice, getExampleInput, getExampleOutput } from './rules-tools.ts';
import { DEFAULT_MAX_OUTPUT_BYTES, type ToolContext } from './tools.ts';
import { json } from '../../test/helpers/api.ts';
import { INVOICES, loadConfig, realClients, startRoutesApi, twoProfiles } from '../../test/helpers/boot.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { principal } from '../../test/helpers/server.ts';

const DOC = `${INVOICES}/document`;
let pki: Pki;
let api: Awaited<ReturnType<typeof startRoutesApi>> | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await api?.fake.close();
  api = undefined;
});

const ctx = (): ToolContext => ({ principal: principal('dev', ['test']), env: 'test', allowWrite: false, prodValidateEnabled: false, visible: [] });
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const queryOf = (url: string) => new URL(url, 'https://x').searchParams;
const AGREEMENT = randomUUID();
const example = () => ({ actionId: AGREEMENT, consignmentId: 'CONSIGNMENT-0001', document: { documentHeader: { channelPriority: ['^X$'] }, invoice: { id: '^.+$', lines: Array.from({ length: 300 }, (_, i) => ({ n: `^\\d{${i}}$`, text: 'x'.repeat(40) })) } } });

async function world(body: unknown = example(), type = 'application/json') {
  api = await startRoutesApi(pki, { [DOC]: (_q, res) => json(res, 200, body, type) });
  const tp = twoProfiles(pki);
  const config = loadConfig(tp.env);
  const clients = realClients(pki, api.fake, config);
  return { ...api, one: createGetExampleInvoice({ clients: new Map([['a', clients.get('a')!]]) }), two: createGetExampleInvoice({ clients }) };
}

describe('get_example_invoice [fake-api]', () => {
  it('drops the agreement id, keeps the rest, fixed notes', async () => {
    const w = await world();
    const r = await w.one.run({ channels: ['EDI'] }, ctx());
    const { actionId: _a, ...rest } = example();
    expect(r).toEqual({ profile: 'a', channels: ['EDI'], example: rest, notes: [...EXAMPLE_NOTES] });
    expect(r.example.consignmentId).toBe('CONSIGNMENT-0001');
    expect('actionId' in r.example).toBe(false);
    expect(JSON.stringify(r)).not.toContain(AGREEMENT);
    expect(getExampleOutput.parse(r)).toEqual(r);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(DEFAULT_MAX_OUTPUT_BYTES);
  });
  it('the notes are the documented list', () => {
    expect(EXAMPLE_NOTES).toHaveLength(4);
    expect(EXAMPLE_NOTES.join('\n')).toMatch(/35 days in production and 7 days in test/);
    expect(EXAMPLE_NOTES.join('\n')).toMatch(/externalDocId/);
  });
  it('a double-encoded body gives the same answer', async () => {
    const w = await world(JSON.stringify(example()), 'text/plain');
    const r = await w.one.run({ channels: ['EDI'] }, ctx());
    expect('actionId' in r.example).toBe(false);
    expect(r.example.consignmentId).toBe('CONSIGNMENT-0001');
  });
  it('joins channels and passes the optional parameters', async () => {
    const w = await world();
    await w.one.run({ channels: ['EDI', 'Kivra'], defaultChannel: 'EDI', templateStandardId: 0 }, ctx());
    await w.one.run({ channels: ['EDI'] }, ctx());
    const [a, b] = w.requests(DOC).map((r) => [...queryOf(r.url).entries()]);
    expect(a).toEqual([['channels', 'EDI,Kivra'], ['defaultChannel', 'EDI'], ['templateStandardId', '0']]);
    expect(b).toEqual([['channels', 'EDI']]);
  });
  it.each([[''], ['[]'], ['"just text"'], ['null'], ['42']])('an empty or non-object body %j is a schema error', async (body) => {
    const w = await world(body, 'text/plain');
    const e = (await rejection(w.one.run({ channels: ['EDI'] }, ctx()))) as { kind: string };
    expect(e.kind).toBe('schema');
  });
  it('does not mutate what it received: two calls give equal answers', async () => {
    const w = await world();
    const a = await w.one.run({ channels: ['EDI'] }, ctx());
    a.example.extra = 1;
    a.notes.push('x');
    const b = await w.one.run({ channels: ['EDI'] }, ctx());
    expect('extra' in b.example).toBe(false);
    expect(b.notes).toHaveLength(4);
  });
  it('profile selection and an upstream 400', async () => {
    const w = await world();
    expect(((await rejection(w.two.run({ channels: ['EDI'] }, ctx()))) as Error).message).toBe('profile is required');
    expect(((await rejection(w.two.run({ channels: ['EDI'], profile: 'zz' }, ctx()))) as Error).message).toBe('unknown profile');
    expect(w.requests(DOC)).toHaveLength(0);
    w.routes[DOC] = (_q, res) => json(res, 400, { title: 'UPSTREAM-TEXT', errors: { channels: ['UPSTREAM-DETAIL'] } }, 'application/problem+json');
    const e = (await rejection(w.one.run({ channels: ['EDI'] }, ctx()))) as { kind: string; message: string };
    expect(e.kind).toBe('bad_request');
    expect(e.message).not.toContain('UPSTREAM');
  });
});

describe('input schema', () => {
  it.each([[{ channels: [] }], [{ channels: ['A', 'B', 'C', 'D', 'E', 'F'] }], [{ channels: [''] }], [{ channels: ['A', ''] }], [{}], [{ channels: ['A'], defaultChannel: '' }], [{ channels: ['A'], templateStandardId: -1 }], [{ channels: 'A' }], [{ channels: ['A,B,C,D,E,F'] }], [{ channels: [',A'] }], [{ channels: ['A,'] }], [{ channels: ['A', 'B,C'] }]])('refuses %j', (input) => {
    expect(getExampleInput.safeParse(input).success).toBe(false);
  });
  it('a name with other punctuation is still a name', () => {
    expect(getExampleInput.safeParse({ channels: ['eBrev/WeMail', 'e-Invoice B2C', 'A_b.c'] }).success).toBe(true);
  });
  it('accepts 1 and 5 channels', () => {
    expect(getExampleInput.safeParse({ channels: ['A'] }).success).toBe(true);
    expect(getExampleInput.safeParse({ channels: ['A', 'B', 'C', 'D', 'E'], templateStandardId: 0 }).success).toBe(true);
  });
});

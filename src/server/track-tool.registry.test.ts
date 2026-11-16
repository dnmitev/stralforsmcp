/* track_document through the registry and the SDK: env gate (PROD listed, GET reaches the stub, write guard intact), outputSchema, span and audit canaries. Real client against a fake API. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { DOCS, HIST, page, rawDoc, rawHistory, receiverCanaries, trackWorld } from '../../test/helpers/track.ts';
import { ERAS, connect, handlerFetch, principal, sink, toAuth } from '../../test/helpers/server.ts';
import { dump, memTelemetry } from '../../test/helpers/telemetry.ts';
import { buildMcp } from './mcp.ts';
import { whoami } from './whoami.ts';

let pki: Pki;
let w: Awaited<ReturnType<typeof trackWorld>> | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const KEY = { invoice: 'INV-CANARY-9c1d', cursor: 'CUR9C1D', doc: 'DCAN9C1D' };

async function setup(env: 'test' | 'prod', p = principal('dev', ['test', 'prod'])) {
  const x = (w = await trackWorld(pki, { env: { STRALFORS_ENV: env } }));
  const s = sink();
  const m = memTelemetry();
  const h = handlerFetch(buildMcp({ env, allowWrite: false, prodValidateEnabled: false, audit: s.audit, tools: [whoami, x.tool], telemetry: m.t }), toAuth(p));
  return { x, s, m, h, c: await connect('modern', h.fetch) };
}
const names = async (c: Awaited<ReturnType<typeof connect>>) => (await c.listTools()).tools.map((t) => t.name);
const call = (c: Awaited<ReturnType<typeof connect>>, args: Record<string, unknown>) => c.callTool({ name: 'track_document', arguments: { profile: 'b', ...args } });

describe('AC-8 visibility and reach', () => {
  it('prod, dev: listed; the lookup and the history GET reach the stub', async () => {
    const { x, s, c } = await setup('prod');
    expect(await names(c)).toContain('track_document');
    const k = receiverCanaries();
    x.serve(DOCS, 200, page([rawDoc(k, { documentId: 'M8I4' })]));
    x.serve(HIST('M8I4'), 200, rawHistory(k));
    const r = await call(c, { documentId: 'M8I4', history: true });
    expect(r.isError).toBeFalsy();
    expect(x.fake.apiRequests.map((q) => [q.method, q.url.split('?')[0]])).toEqual([['GET', DOCS], ['GET', HIST('M8I4')]]);
    expect(s.lines().map((l) => [l.tool, l.env, l.outcome])).toEqual([['track_document', 'prod', 'allowed']]);
  });
  it('prod: a lookup for a document id the guard refuses never reaches the stub (bad id is refused by the schema)', async () => {
    const { x, c } = await setup('prod');
    const r = await call(c, { documentId: 'M8/../I4X', history: true }).then((v) => v.isError === true, () => true);
    expect(r).toBe(true);
    expect(x.fake.apiRequests).toHaveLength(0);
  });
  it('prod: qa/pm without prod access do not see it and cannot call it', async () => {
    for (const role of ['qa', 'pm'] as const) {
      const { x, c } = await setup('prod', principal(role, ['test']));
      expect(await names(c), role).not.toContain('track_document');
      expect(await call(c, { invoiceNumber: 'a' }).then((r) => r.isError === true, () => true)).toBe(true);
      expect(x.fake.apiRequests).toHaveLength(0);
      await w?.close();
    }
  });
  it('test env: listed for dev, qa and pm', async () => {
    for (const role of ['dev', 'qa', 'pm'] as const) {
      const { c } = await setup('test', principal(role, ['test']));
      expect(await names(c), role).toContain('track_document');
      await w?.close();
    }
  });
  it('the registry lists whoami and track_document in order', async () => {
    const { c } = await setup('test');
    expect(await names(c)).toEqual(['whoami', 'track_document']);
  });
});

describe('schema and structured output', () => {
  it.each(ERAS)('annotations, outputSchema, structuredContent (%s era)', async (era) => {
    const { x, h } = await setup('test');
    x.serve(DOCS, 200, page([rawDoc(receiverCanaries())], false));
    const c = await connect(era, h.fetch);
    const t = (await c.listTools()).tools.find((v) => v.name === 'track_document')!;
    expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(t.outputSchema).toBeTruthy();
    const r = await call(c, { invoiceNumber: 'INV-1' });
    expect(x.tool.outputSchema.parse(r.structuredContent)).toMatchObject({ profile: 'b', hasMore: true, nextCursor: 'M8I4' });
  });
});

describe('AC-9 privacy: audit, spans, metrics, logs carry nothing from the call', () => {
  it.each(['ok', 'not_found', 'upstream'] as const)('%s', async (kind) => {
    const { x, s, m, c } = await setup('test');
    const k = receiverCanaries();
    if (kind === 'not_found') x.serve(DOCS, 404, { message: `${KEY.invoice} ${k.receiverName}` });
    else if (kind === 'upstream') x.serve(DOCS, 500, `${KEY.invoice} ${k.receiverName}`);
    else x.serve(DOCS, 200, page([rawDoc(k, { invoiceNumber: KEY.invoice })], false));
    await call(c, { invoiceNumber: KEY.invoice, cursor: KEY.cursor });
    const lines = s.lines().filter((l) => l.tool === 'track_document');
    expect(lines).toHaveLength(1);
    for (const key of Object.keys(lines[0]!)) expect(['ts', 'level', 'log.type', 'userId', 'role', 'tool', 'env', 'outcome', 'reason', 'durationMs'], key).toContain(key);
    expect(lines[0]!.outcome).toBe(kind === 'ok' ? 'allowed' : 'error');
    const all = s.text() + dump(m.spans()) + (await m.text()) + x.log.text();
    for (const v of [...Object.values(KEY), ...Object.values(k), 'M8I4']) expect(all, `${kind} ${v}`).not.toContain(v);
  });
  it('a history call with the id as key leaves no id in telemetry either', async () => {
    const { x, s, m, c } = await setup('test');
    const k = receiverCanaries();
    x.serve(DOCS, 200, page([rawDoc(k, { documentId: KEY.doc })]));
    x.serve(HIST(KEY.doc), 200, rawHistory(k));
    await call(c, { documentId: KEY.doc, history: true });
    const all = s.text() + dump(m.spans()) + (await m.text()) + x.log.text();
    for (const v of [KEY.doc, ...Object.values(k)]) expect(all, v).not.toContain(v);
  });
});

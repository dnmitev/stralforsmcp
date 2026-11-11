/*
 * R32 upstreamInstrument (src/telemetry): spans, metrics, no outbound tracing headers, log correlation. Hook plumbing itself: instrument.hook.test.ts.
 */
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createClient, loadConfig, type CreateClientOptions } from './index.ts';
import { createLogger } from './log.ts';
import { json, makeEnv } from '../../test/helpers/api.ts';
import { startChannelsApi } from '../../test/helpers/boot.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { canaries, hist, memTelemetry, num, pick, dump } from '../../test/helpers/telemetry.ts';
import { logMixin, upstreamInstrument, withSpan } from '../telemetry/index.ts';

let pki: Pki;
let api: Awaited<ReturnType<typeof startChannelsApi>> | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await api?.fake.close();
  api = undefined;
});

async function setup(instrument?: CreateClientOptions['instrument'], extra: Record<string, string | undefined> = {}, logger?: CreateClientOptions['logger']) {
  api = await startChannelsApi(pki);
  const config = loadConfig(makeEnv(pki, { extra }).env);
  const client = createClient({ config, profileId: 'a', ca: pki.ca, baseUrl: api.fake.url, ...(instrument ? { instrument } : {}), ...(logger ? { logger } : {}) });
  return { client, ...api };
}
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe('upstreamInstrument [fake-api]', () => {
  const agreementUuid = '11111111-2222-3333-4444-555555555555';
  async function world(extra: Record<string, string> = {}) { // default deadline: only the timeout test shortens it
    const m = memTelemetry();
    const w = await setup(upstreamInstrument(m.t), extra);
    return { m, ...w };
  }
  const base = { 'stralfors.operation': 'channels', 'http.request.method': 'GET' };

  it('three calls: ok, 404, 429 -> three CLIENT spans with exact attributes and statuses', async () => {
    const { m, client, reply } = await world();
    await client.channels();
    reply.current = (_q, res) => json(res, 404, { message: `action id '${agreementUuid}' not found` });
    await rejection(client.channels(agreementUuid));
    reply.current = (_q, res) => (res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' }), res.end('{}'));
    await rejection(client.channels());

    const spans = m.byName('stralfors.request');
    expect(spans).toHaveLength(3);
    for (const s of spans) expect(s.kind).toBe(SpanKind.CLIENT);
    expect(spans.map((s) => s.attributes)).toEqual([
      base,
      { ...base, 'error.type': 'agreement_not_found', 'http.response.status_code': 404 },
      { ...base, 'error.type': 'rate_limited', 'http.response.status_code': 429 },
    ]);
    expect(spans.map((s) => s.status.code)).toEqual([SpanStatusCode.UNSET, SpanStatusCode.ERROR, SpanStatusCode.ERROR]);
    for (const s of spans) {
      expect(s.status.message).toBeUndefined();
      expect(s.events).toEqual([]);
    }

    const req = await m.series('stralfors.requests');
    expect(num(pick(req, { operation: 'channels', outcome: 'ok' }))).toBe(1);
    for (const kind of ['agreement_not_found', 'rate_limited']) expect(num(pick(req, { operation: 'channels', outcome: 'error', 'error.type': kind }))).toBe(1);
    expect(req).toHaveLength(3);
    const dur = await m.series('stralfors.request.duration');
    expect(hist(pick(dur, { operation: 'channels', outcome: 'ok' })).count).toBe(1);
    expect(dur).toHaveLength(3);
  });

  it('a call that outlives the deadline -> CLIENT span and metrics with error.type timeout', async () => {
    const { m, client, reply, channelRequests } = await world({ STRALFORS_TIMEOUT_MS: '50' });
    reply.current = (_q, res) => void setTimeout(() => res.destroyed || res.end('[]'), 600); // never answers within the deadline
    await rejection(client.channels());
    expect(channelRequests()).toHaveLength(1); // the request reached the endpoint, so this is not a token-step timeout
    const [span] = m.byName('stralfors.request');
    expect(span!.attributes).toEqual({ ...base, 'error.type': 'timeout' });
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(num(pick(await m.series('stralfors.requests'), { operation: 'channels', outcome: 'error', 'error.type': 'timeout' }))).toBe(1);
    expect(hist(pick(await m.series('stralfors.request.duration'), { operation: 'channels', outcome: 'error', 'error.type': 'timeout' })).count).toBe(1);
  });

  it('a non-Stralfors throw is error.type "error" without a status code', async () => {
    const m = memTelemetry();
    const inst = upstreamInstrument(m.t);
    const c = canaries();
    await rejection(inst({ operation: 'channels', method: 'GET' }, async () => { throw new Error(c.msg); }));
    const s = m.byName('stralfors.request')[0]!;
    expect(s.attributes).toEqual({ ...base, 'error.type': 'error' });
    expect(dump(m.spans())).not.toContain(c.msg);
    expect(JSON.stringify(await m.series('stralfors.requests'))).toContain('"error.type":"error"');
  });

  it('the operation is "raw" for a bare call and the method label is closed', async () => {
    const m = memTelemetry();
    const inst = upstreamInstrument(m.t);
    const c = canaries();
    await inst({ operation: 'raw', method: c.method }, async () => 1);
    expect(m.spans()[0]!.attributes).toEqual({ 'stralfors.operation': 'raw', 'http.request.method': '_OTHER' });
  });

  it('no path, query, id or URL on any span or label', async () => {
    const { m, client, fake } = await world();
    await client.channels(agreementUuid);
    const all = dump(m.spans()) + (await m.text());
    for (const bad of [agreementUuid, 'outputmanagement', 'invoices', '127.0.0.1', 'actionId']) expect(all).not.toContain(bad);
    // the port is checked in endpoint-bearing form only: a decimal substring of a generated trace id is not a leak
    for (const bad of [`:${fake.port}`, `port="${fake.port}"`, `"${fake.port}"`]) expect(all).not.toContain(bad);
  });

  it('inside an active root span: child of it, and no tracing header reaches the fake API (token or API request)', async () => {
    const { m, client, fake } = await world();
    await withSpan(m.t.tracer, 'root', SpanKind.SERVER, {}, () => client.channels(), () => 'error');
    const root = m.byName('root')[0]!;
    const up = m.byName('stralfors.request')[0]!;
    expect(up.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(up.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(fake.requests.length).toBeGreaterThanOrEqual(2);
    for (const r of fake.requests) for (const h of ['traceparent', 'tracestate', 'baggage', 'b3', 'x-b3-traceid', 'x-request-id']) expect(r.headers, h).not.toHaveProperty(h);
  });

  it('log lines carry the ids of the stralfors.request span inside it and none outside', async () => {
    const chunks: string[] = [];
    const m = memTelemetry();
    const logger = createLogger({ level: 'trace', destination: { write: (s) => void chunks.push(s) }, mixin: logMixin });
    const w = await setup(upstreamInstrument(m.t), {}, logger);
    const lines = () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    await w.client.channels();
    const inside = lines().filter((l) => l.msg === 'request');
    expect(inside).toHaveLength(1);
    const sc = m.byName('stralfors.request')[0]!.spanContext();
    expect(inside[0]).toMatchObject({ trace_id: sc.traceId, span_id: sc.spanId });
    expect(sc.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(sc.spanId).toMatch(/^[0-9a-f]{16}$/);
    // outside any span (hook absent): no ids
    chunks.length = 0;
    logger.info({ status: 1 }, 'outside');
    expect('trace_id' in lines()[0]! || 'span_id' in lines()[0]!).toBe(false);
    expect(logger.droppedKeys).toBe(0);
  });
});

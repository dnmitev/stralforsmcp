/*
 * R30 request telemetry. API under test: createHttpServer({ telemetry? }) (src/server/http.ts).
 * Root span 'POST /mcp' after the cheap guards; http.server.request.duration for every request except /healthz and /readyz;
 * mcp.auth.rejections{reason}, mcp.http.rate_limited; incoming traceparent ignored; no sensitive attribute anywhere.
 */
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import { ALLOWED_SPAN_KEYS } from '../telemetry/instruments.ts';
import { createRateLimiter } from './rate-limit.ts';
import { startHttp } from '../../test/helpers/http-harness.ts';
import { INIT, LIST, MCP_HEADERS, send } from '../../test/helpers/server.ts';
import { canaries, hist, memTelemetry, num, pick, dump } from '../../test/helpers/telemetry.ts';

const DUR = 'http.server.request.duration';
const root = (m: ReturnType<typeof memTelemetry>) => m.byName('POST /mcp');
const flush = async (m: ReturnType<typeof memTelemetry>, want: number) => {
  await vi.waitFor(async () => expect((await m.series(DUR)).reduce((n, s) => n + hist(s).count, 0)).toBe(want));
  return m.series(DUR);
};

describe('root span', () => {
  it('one SERVER span per handled request with exactly method, route and status code', async () => {
    const m = memTelemetry();
    const h = await startHttp({ telemetry: m.t });
    expect((await h.post({ body: LIST })).status).toBe(200);
    expect(m.spans()).toHaveLength(1);
    const s = root(m)[0]!;
    expect(s.kind).toBe(SpanKind.SERVER);
    expect(s.parentSpanContext).toBeUndefined();
    expect(s.attributes).toEqual({ 'http.request.method': 'POST', 'http.route': '/mcp', 'http.response.status_code': 200 });
    expect(s.status.code).toBe(SpanStatusCode.UNSET);
    expect(s.events).toEqual([]);
  });

  it('every request is its own root with its own trace id', async () => {
    const m = memTelemetry();
    const h = await startHttp({ telemetry: m.t });
    await h.post({ body: LIST });
    await h.post({ body: LIST });
    expect(new Set(root(m).map((s) => s.spanContext().traceId)).size).toBe(2);
  });

  it('an incoming traceparent / tracestate is ignored: new trace, no parent, nothing copied', async () => {
    const m = memTelemetry();
    const h = await startHttp({ telemetry: m.t });
    const inTrace = '0af7651916cd43dd8448eb211c80319c';
    const inSpan = 'b7ad6b7169203331';
    await h.post({ body: LIST, headers: { traceparent: `00-${inTrace}-${inSpan}-01`, tracestate: 'vendor=TRACESTATE-CANARY', baggage: 'k=BAGGAGE-CANARY' } });
    const s = root(m)[0]!;
    expect(s.spanContext().traceId).not.toBe(inTrace);
    expect(s.parentSpanContext).toBeUndefined();
    const all = dump(m.spans()) + h.s.text() + (await m.text());
    for (const bad of [inTrace, inSpan, 'CANARY']) expect(all).not.toContain(bad);
  });

  it('a traceparent with the sampled flag cannot force sampling when the ratio is 0', async () => {
    const m = memTelemetry({ sampleRatio: 0 });
    const h = await startHttp({ telemetry: m.t });
    await h.post({ body: LIST, headers: { traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01` } });
    expect(m.spans()).toHaveLength(0);
  });

  it('handler throw (the 500 path): ERROR status, fixed error.type, status 500, no events, no message', async () => {
    const m = memTelemetry();
    const c = canaries();
    const h = await startHttp({ telemetry: m.t, audit: { record: () => { throw new Error(c.msg); } } });
    const r = await h.post({ token: h.w.unknown });
    expect(r.status).toBe(500);
    const s = root(m)[0]!;
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.status.message).toBeUndefined();
    expect(s.attributes).toMatchObject({ 'error.type': 'error', 'http.response.status_code': 500 });
    expect(s.events).toEqual([]);
    expect(dump(m.spans())).not.toContain(c.msg);
  });
});

describe('refusals', () => {
  it.each([
    ['unknown token', 'unknown'],
    ['expired token', 'expired'],
    ['revoked token', 'revoked'],
    ['no Authorization header', 'malformed'],
  ] as const)('401 (%s): span error.type %s, status UNSET, counter mcp.auth.rejections{reason}', async (name, reason) => {
    const m = memTelemetry();
    const h = await startHttp({ telemetry: m.t });
    const token = { 'unknown token': h.w.unknown, 'expired token': h.w.tExpired, 'revoked token': h.w.tRevoked, 'no Authorization header': null }[name];
    const r = await h.post({ token });
    expect(r.status).toBe(401);
    expect(r.text).toBe('{"error":"invalid_token"}'); // bytes unchanged
    expect(root(m)).toHaveLength(1);
    expect(root(m)[0]!.attributes).toEqual({ 'http.request.method': 'POST', 'http.route': '/mcp', 'error.type': reason, 'http.response.status_code': 401 });
    expect(root(m)[0]!.status.code).toBe(SpanStatusCode.UNSET);
    const rej = await m.series('mcp.auth.rejections');
    expect(rej).toHaveLength(1);
    expect(num(pick(rej, { reason }))).toBe(1);
    expect(await m.series('mcp.http.rate_limited')).toEqual([]);
  });

  it('429: error.type rate_limited, status 429, mcp.http.rate_limited 1, rejections untouched', async () => {
    const m = memTelemetry();
    const h = await startHttp({ telemetry: m.t, limiter: createRateLimiter({ perMinute: 1, burst: 1, now: () => 0 }) });
    expect((await h.post({ body: LIST })).status).toBe(200);
    const r = await h.post({ body: LIST });
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
    const s = root(m).at(-1)!;
    expect(s.attributes).toEqual({ 'http.request.method': 'POST', 'http.route': '/mcp', 'error.type': 'rate_limited', 'http.response.status_code': 429 });
    expect(s.status.code).toBe(SpanStatusCode.UNSET);
    expect(num((await m.series('mcp.http.rate_limited'))[0])).toBe(1);
    expect((await m.series('mcp.http.rate_limited'))[0]!.attributes).toEqual({});
    expect(await m.series('mcp.auth.rejections')).toEqual([]);
  });

  it('guard refusals create no span but still count in the duration histogram with their status', async () => {
    const m = memTelemetry();
    const h = await startHttp({ telemetry: m.t });
    expect((await h.post({ headers: { host: 'wrong.example.test' } })).status).toBe(403);
    expect((await send(h.port, { method: 'GET', headers: { ...MCP_HEADERS } })).status).toBe(405);
    expect((await send(h.port, { method: 'PROPFIND', headers: { ...MCP_HEADERS } })).status).toBe(405);
    expect((await send(h.port, { method: 'GET', path: '/metrics' })).text).toBe('not found');
    expect((await send(h.port, { path: '/mcp', headers: { 'content-length': '5000' }, hold: true })).status).toBe(413);
    expect(m.spans()).toHaveLength(0);
    const d = await flush(m, 5);
    const k = (method: string, status: number) => ({ 'http.request.method': method, 'http.response.status_code': status, 'http.route': '/mcp' });
    expect(hist(pick(d, k('POST', 403))).count).toBe(1);
    expect(hist(pick(d, k('GET', 405))).count).toBe(1);
    expect(hist(pick(d, k('_OTHER', 405))).count).toBe(1);
    expect(hist(pick(d, k('GET', 404))).count).toBe(1);
    expect(hist(pick(d, k('POST', 413))).count).toBe(1);
    expect(await m.series('mcp.auth.rejections')).toEqual([]);
    expect(await m.text()).not.toContain('PROPFIND');
  });

  it('/healthz and /readyz are neither spanned nor measured', async () => {
    const m = memTelemetry();
    const h = await startHttp({ telemetry: m.t, hosts: ['127.0.0.1'] });
    for (const p of ['/healthz', '/readyz']) expect((await send(h.port, { method: 'GET', path: p })).status).toBe(200);
    await h.post({ headers: { host: '127.0.0.1' }, body: LIST });
    await flush(m, 1); // only the MCP request
    expect(m.spans().map((s) => s.name)).toEqual(['POST /mcp']);
  });
});

describe('request duration histogram', () => {
  it('records seconds (not milliseconds) on the second-scale buckets with the three labels', async () => {
    const m = memTelemetry();
    let ms = -250; // controlled clock: start 0, finish 250 ms
    const h = await startHttp({ telemetry: m.t, monotonic: () => (ms += 250) });
    await h.post({ body: INIT });
    const d = await flush(m, 1);
    expect(d[0]!.attributes).toEqual({ 'http.request.method': 'POST', 'http.response.status_code': 200, 'http.route': '/mcp' });
    expect(hist(d[0]).sum).toBe(0.25); // seconds, not milliseconds
    expect(hist(d[0]).buckets.boundaries[0]).toBe(0.005);
  });

  it('the status label is the status actually sent', async () => {
    const m = memTelemetry();
    const h = await startHttp({ telemetry: m.t });
    await h.post({ body: LIST });
    await h.post({ token: h.w.unknown });
    const d = await flush(m, 2);
    expect(d.map((s) => s.attributes['http.response.status_code']).sort()).toEqual([200, 401]);
  });
});

describe('privacy canary through every request path', () => {
  it('no span, label, key or trace id carries a caller-controlled or secret value', async () => {
    const m = memTelemetry();
    const c = canaries();
    const h = await startHttp({ telemetry: m.t, hosts: ['mcp.example.test'], limiter: createRateLimiter({ perMinute: 1, burst: 1, now: () => 0 }) });
    const hdr = { 'user-agent': c.ua, 'x-forwarded-for': c.user, traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`, referer: `http://${c.path}.example.test/` };
    await h.post({ token: c.token, headers: hdr, body: c.body, path: `/mcp?q=${c.query}` });
    await h.post({ token: h.w.tA, headers: hdr, body: LIST, path: `/mcp?q=${c.query}` });
    await h.post({ token: h.w.tA, headers: hdr, body: LIST });
    await h.post({ headers: { ...hdr, host: `${c.path}.example.test` }, body: c.body });
    await h.post({ headers: hdr, body: c.body, path: `/${c.path}?q=${c.query}` });
    await send(h.port, { method: 'GET', path: `/mcp?q=${c.query}`, headers: { ...hdr, authorization: `Bearer ${c.token}` } });
    await flush(m, 6);
    const spans = dump(m.spans());
    const text = await m.text();
    for (const v of [c.token, c.user, c.path, c.query, c.body, c.ua, h.w.tA, h.w.unknown, '3'.repeat(32), '4'.repeat(16)]) {
      expect(spans, v).not.toContain(v);
      expect(text, v).not.toContain(v);
    }
    for (const s of m.spans()) for (const k of Object.keys(s.attributes)) expect(ALLOWED_SPAN_KEYS.has(k), k).toBe(true);
    for (const k of ['url.full', 'url.query', 'url.path', 'server.address', 'client.address', 'user_agent.original']) expect(spans).not.toContain(k);
    expect(spans).not.toContain('http.request.header');
    expect(text).not.toMatch(/="[0-9a-f]{32}"|="[0-9a-f]{16}"/);
    expect(text).not.toMatch(/trace_id|span_id|traceId/);
  });
});

describe('without telemetry', () => {
  it('nothing is created and the responses are unchanged', async () => {
    const bystander = memTelemetry();
    const h = await startHttp();
    expect((await h.post({ body: LIST })).status).toBe(200);
    expect((await h.post({ token: h.w.unknown })).status).toBe(401);
    expect(bystander.spans()).toHaveLength(0);
    expect(await bystander.series(DUR)).toEqual([]);
  });
});

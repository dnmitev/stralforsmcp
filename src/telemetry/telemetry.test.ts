/*
 * R27/R28 telemetry core. API under test (src/telemetry/index.ts): createTelemetry, withSpan, setSafe, activeIds, logMixin, SERVICE_NAME.
 * Seams: spanExporter (SimpleSpanProcessor), metricReader (next to the Prometheus reader). test/helpers/telemetry.ts disables global OTel state after each test.
 */
import { Server } from 'node:http';
import { createServer } from 'node:net';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { describe, expect, it, vi } from 'vitest';
import { withPrincipal, currentPrincipal } from '../server/context.ts';
import { principal } from '../../test/helpers/server.ts';
import { canaries, hist, memTelemetry, num, pick, scrape, dump } from '../../test/helpers/telemetry.ts';
import { INSTRUMENTS, SECONDS } from './instruments.ts';
import { SERVICE_NAME, activeIds, createTelemetry, logMixin, setSafe, withSpan } from './index.ts';

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const closedPort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number };
    s.close(() => resolve(port));
  });
});

describe('seams and spans', () => {
  it('SERVICE_NAME is fixed', () => {
    expect(SERVICE_NAME).toBe('stralfors-mcp');
  });

  it('withSpan: one finished span with name, kind, attributes, UNSET status and no events', async () => {
    const m = memTelemetry();
    await expect(withSpan(m.t.tracer, 'x', SpanKind.INTERNAL, { tool: 'a' }, async () => 1, () => 'error')).resolves.toBe(1);
    expect(m.spans()).toHaveLength(1);
    const s = m.spans()[0]!;
    expect([s.name, s.kind, s.attributes, s.status.code, s.events]).toEqual(['x', SpanKind.INTERNAL, { tool: 'a' }, SpanStatusCode.UNSET, []]);
  });

  it('withSpan on throw: same error rethrown, ERROR status without message, fixed error.type, no exception event, message nowhere', async () => {
    const m = memTelemetry();
    const c = canaries();
    const boom = new Error(c.msg);
    await expect(withSpan(m.t.tracer, 'y', SpanKind.CLIENT, { tool: 'a' }, async () => { throw boom; }, () => 'timeout')).rejects.toBe(boom);
    const s = m.spans()[0]!;
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.status.message).toBeUndefined();
    expect(s.attributes).toEqual({ tool: 'a', 'error.type': 'timeout' });
    expect(s.events).toHaveLength(0);
    expect(dump([s])).not.toContain(c.msg);
  });

  it('withSpan makes the span active inside fn and ends it exactly once', async () => {
    const m = memTelemetry();
    const inside = await withSpan(m.t.tracer, 'z', SpanKind.INTERNAL, {}, async (span) => [trace.getActiveSpan() === span, m.spans().length], () => 'error');
    expect(inside).toEqual([true, 0]);
    expect(m.spans()).toHaveLength(1);
  });

  it('setSafe keeps allowlisted keys, drops and counts the rest', () => {
    const m = memTelemetry();
    const c = canaries();
    expect(m.t.droppedKeys).toBe(0);
    const span = m.t.tracer.startSpan('s');
    setSafe(span, { tool: 'a', userId: c.user, 'url.full': c.path });
    span.end();
    expect(m.spans()[0]!.attributes).toEqual({ tool: 'a' });
    expect(m.t.droppedKeys).toBe(2);
  });

  it('setSafe accepts every allowlisted key', () => {
    const m = memTelemetry();
    const span = m.t.tracer.startSpan('s');
    const all = { 'http.request.method': 'POST', 'http.response.status_code': 200, 'http.route': '/mcp', 'error.type': 'error', tool: 't', outcome: 'allowed', env: 'test', 'stralfors.operation': 'channels' };
    setSafe(span, all);
    span.end();
    expect(m.spans()[0]!.attributes).toEqual(all);
    expect(m.t.droppedKeys).toBe(0);
  });
});

describe('resource and sampler', () => {
  it('resource carries exactly service.name, service.version, deployment.environment.name', async () => {
    const m = memTelemetry({ serviceVersion: '9.8.7', env: 'prod' });
    await withSpan(m.t.tracer, 'r', SpanKind.INTERNAL, {}, async () => 0, () => 'error');
    const a = m.spans()[0]!.resource.attributes;
    expect(Object.keys(a).sort()).toEqual(['deployment.environment.name', 'service.name', 'service.version']);
    expect(a).toMatchObject({ 'service.name': 'stralfors-mcp', 'service.version': '9.8.7', 'deployment.environment.name': 'prod' });
  });

  it('ratio 0 records and exports nothing but ids stay available (unsampled spans still correlate logs)', async () => {
    const m = memTelemetry({ sampleRatio: 0 });
    const ids = await withSpan(m.t.tracer, 'u', SpanKind.SERVER, {}, async (s) => [s.isRecording(), activeIds()] as const, () => 'error');
    expect(ids[0]).toBe(false);
    expect(ids[1]!.trace_id).toMatch(HEX32);
    expect(m.spans()).toHaveLength(0);
  });

  it('ratio 1 exports every root span; a child follows its root (parent based)', async () => {
    const m = memTelemetry({ sampleRatio: 1 });
    for (let i = 0; i < 100; i++) await withSpan(m.t.tracer, 'root', SpanKind.SERVER, {}, async () => 0, () => 'error');
    expect(m.byName('root')).toHaveLength(100);
    await withSpan(m.t.tracer, 'p', SpanKind.SERVER, {}, () => withSpan(m.t.tracer, 'c', SpanKind.INTERNAL, {}, async () => 0, () => 'error'), () => 'error');
    expect(m.byName('c')).toHaveLength(1);
    expect(m.byName('c')[0]!.parentSpanContext?.spanId).toBe(m.byName('p')[0]!.spanContext().spanId);
  });

  it('a child of an unsampled root is not exported either', async () => {
    const m = memTelemetry({ sampleRatio: 0 });
    await withSpan(m.t.tracer, 'p', SpanKind.SERVER, {}, () => withSpan(m.t.tracer, 'c', SpanKind.INTERNAL, {}, async () => 0, () => 'error'), () => 'error');
    expect(m.spans()).toHaveLength(0);
  });

  it('a root span has no parent even when started inside a foreign active context', async () => {
    const m = memTelemetry();
    await withSpan(m.t.tracer, 'root', SpanKind.SERVER, {}, async () => 0, () => 'error');
    expect(m.spans()[0]!.parentSpanContext).toBeUndefined();
  });
});

describe('foreign active span and foreign context manager', () => {
  it('a SERVER span ignores a foreign active span: new trace, no parent', async () => {
    const m = memTelemetry();
    const foreign = trace.wrapSpanContext({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 });
    await context.with(trace.setSpan(context.active(), foreign), () => withSpan(m.t.tracer, 'srv', SpanKind.SERVER, {}, async () => 0, () => 'error'));
    const s = m.byName('srv')[0]!;
    expect(s.parentSpanContext).toBeUndefined();
    expect(s.spanContext().traceId).not.toBe('a'.repeat(32));
  });

  it('shutdown leaves another SDK\'s global context manager alone', async () => {
    const foreign = new AsyncLocalStorageContextManager().enable();
    expect(context.setGlobalContextManager(foreign)).toBe(true);
    const m = memTelemetry();
    await m.t.shutdown();
    const span = trace.wrapSpanContext({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 });
    expect(context.with(trace.setSpan(context.active(), span), () => trace.getActiveSpan() === span)).toBe(true);
    foreign.disable();
  });
});

describe('context manager (V-1)', () => {
  it('outside any span: no ids, empty mixin', () => {
    memTelemetry();
    expect(activeIds()).toBeUndefined();
    expect(logMixin()).toEqual({});
  });

  it('inside a span: 32 and 16 lowercase hex equal to the span ids, mixin returns exactly them', async () => {
    const m = memTelemetry();
    const [ids, mixin] = await withSpan(m.t.tracer, 'a', SpanKind.INTERNAL, {}, async () => [activeIds(), logMixin()] as const, () => 'error');
    expect(ids!.trace_id).toMatch(HEX32);
    expect(ids!.span_id).toMatch(HEX16);
    expect(Object.keys(ids!).sort()).toEqual(['span_id', 'trace_id']);
    expect(mixin).toEqual(ids);
    const sc = m.spans()[0]!.spanContext();
    expect(ids).toEqual({ trace_id: sc.traceId, span_id: sc.spanId });
  });

  it('survives an await and a timer hop', async () => {
    const m = memTelemetry();
    const [a, b] = await withSpan(m.t.tracer, 'a', SpanKind.INTERNAL, {}, async () => {
      const before = activeIds();
      await new Promise((r) => setTimeout(r, 5));
      return [before, activeIds()];
    }, () => 'error');
    expect(b).toEqual(a);
  });

  it('is re-registrable: shutdown, then a new telemetry works', async () => {
    const t1 = memTelemetry();
    await t1.t.shutdown();
    const t2 = memTelemetry();
    const ids = await withSpan(t2.t.tracer, 'y', SpanKind.INTERNAL, {}, async () => activeIds(), () => 'error');
    expect(ids!.trace_id).toMatch(HEX32);
    expect(ids!.span_id).toMatch(HEX16);
    expect(activeIds()).toBeUndefined();
  });

  it('shutdown unregisters the context manager', async () => {
    const m = memTelemetry();
    const fake = trace.wrapSpanContext({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 });
    const probe = () => context.with(trace.setSpan(context.active(), fake), () => trace.getActiveSpan() === fake);
    expect(probe()).toBe(true);
    await m.t.shutdown();
    expect(probe()).toBe(false);
  });

  it('principal context and active span both survive an await, in both nestings', async () => {
    const m = memTelemetry();
    const p = principal('dev', ['test']);
    const work = async () => {
      await new Promise((r) => setTimeout(r, 1));
      return [currentPrincipal(), activeIds()] as const;
    };
    const [p1, i1] = await withPrincipal(p, () => withSpan(m.t.tracer, 'z', SpanKind.INTERNAL, {}, work, () => 'error'));
    expect(p1).toBe(p);
    expect(i1!.trace_id).toMatch(HEX32);
    const [p2, i2] = await withSpan(m.t.tracer, 'z2', SpanKind.INTERNAL, {}, () => withPrincipal(p, work), () => 'error');
    expect(p2).toBe(p);
    expect(i2!.trace_id).toMatch(HEX32);
  });
});

describe('metrics views: every instrument drops every key outside its table row', () => {
  const junk = () => { const c = canaries(); return { userId: c.user, path: `/${c.path}`, 'url.full': c.query, trace_id: 'a'.repeat(32), agreement: c.agreement }; };
  const sample: Record<string, unknown> = { 'http.request.method': 'POST', 'http.response.status_code': 200, 'http.route': '/mcp', reason: 'unknown', tool: 'whoami', outcome: 'allowed', env: 'test', operation: 'channels', 'error.type': 'timeout' };

  it.each(Object.entries(INSTRUMENTS))('%s', async (key, spec) => {
    const m = memTelemetry();
    const attrs = { ...Object.fromEntries(spec.keys.map((k) => [k, sample[k]])), ...junk() };
    if (spec.kind === 'observable_gauge') {
      // same descriptor as the table row: the SDK shares the stream, the View applies by instrument name
      m.t.meter.createObservableGauge(spec.name, { unit: spec.unit, description: spec.description }).addCallback((r) => r.observe(7, attrs));
    } else {
      const inst = (m.t.instruments as unknown as Record<string, { add?: (v: number, a: object) => void; record?: (v: number, a: object) => void }>)[key]!;
      if (spec.kind === 'counter') inst.add!(1, attrs);
      else inst.record!(0.3, attrs);
    }
    const series = await m.series(spec.name);
    expect(series).toHaveLength(1);
    expect(Object.keys(series[0]!.attributes).sort()).toEqual([...spec.keys].sort());
    expect(JSON.stringify(series)).not.toContain('CANARY');
    expect(JSON.stringify(series)).not.toContain('a'.repeat(32));
    expect(await m.text()).not.toContain('CANARY');
  });

  it('an allowed key with its own value survives (the View is an allowlist, not a blanket drop)', async () => {
    const m = memTelemetry();
    m.t.instruments.toolCalls.add(2, { tool: 'whoami', outcome: 'denied', env: 'prod', userId: 'x' });
    expect(pick(await m.series('mcp.tool.calls'), { tool: 'whoami', outcome: 'denied', env: 'prod' })?.value).toBe(2);
  });
});

describe('histograms are second-scale', () => {
  it.each(['httpDuration', 'toolDuration', 'upstreamDuration'] as const)('%s uses the SECONDS boundaries', async (key) => {
    const m = memTelemetry();
    const attrs = { 'http.request.method': 'POST', 'http.response.status_code': 200, 'http.route': '/mcp', tool: 't', outcome: 'allowed', operation: 'o' };
    m.t.instruments[key].record(0.3, attrs);
    const [s] = await m.series(INSTRUMENTS[key].name);
    expect(hist(s).buckets.boundaries).toEqual([...SECONDS]);
    expect(hist(s).count).toBe(1);
    expect(hist(s).sum).toBeCloseTo(0.3);
    expect(hist(s).buckets.counts.indexOf(1)).toBe(SECONDS.indexOf(0.5)); // 0.25 < 0.3 <= 0.5
  });
});

describe('stale gauge', () => {
  it('reads the source at collection time (seconds) and a later observeStale replaces the source', async () => {
    const m = memTelemetry();
    let ms = 90_000;
    m.t.instruments.observeStale(() => ms);
    expect(num((await m.series('mcp.token_list.stale_seconds'))[0])).toBe(90);
    ms = 0;
    expect(num((await m.series('mcp.token_list.stale_seconds'))[0])).toBe(0);
    m.t.instruments.observeStale(() => 5_500);
    expect(num((await m.series('mcp.token_list.stale_seconds'))[0])).toBe(5.5);
  });

  it('has no attributes', async () => {
    const m = memTelemetry();
    m.t.instruments.observeStale(() => 1000);
    expect((await m.series('mcp.token_list.stale_seconds'))[0]!.attributes).toEqual({});
  });
});

describe('Prometheus text (exporter naming pinned as observed)', () => {
  it('dots become underscores, counters gain _total, the unit is a # UNIT line and never a suffix, no scope labels', async () => {
    const m = memTelemetry({ serviceVersion: '1.2.3' });
    const { instruments: i } = m.t;
    i.httpDuration.record(0.2, { 'http.request.method': 'POST', 'http.response.status_code': 200, 'http.route': '/mcp' });
    i.authRejections.add(1, { reason: 'unknown' });
    i.rateLimited.add(1);
    i.toolCalls.add(1, { tool: 'whoami', outcome: 'allowed', env: 'test' });
    i.toolDuration.record(0.2, { tool: 'whoami', outcome: 'allowed' });
    i.upstreamRequests.add(1, { operation: 'channels', outcome: 'error', 'error.type': 'timeout' });
    i.upstreamDuration.record(0.2, { operation: 'channels', outcome: 'error', 'error.type': 'timeout' });
    i.observeStale(() => 0);
    const text = await m.text();
    const lines = text.split('\n');
    const has = (x: string | RegExp) => expect(lines.some((l) => (typeof x === 'string' ? l === x : x.test(l))), String(x)).toBe(true);
    has('# UNIT http_server_request_duration s');
    has('# TYPE http_server_request_duration histogram');
    has(/^http_server_request_duration_count\{http_request_method="POST",http_response_status_code="200",http_route="\/mcp"\} 1$/);
    has(/^http_server_request_duration_sum\{http_request_method="POST",http_response_status_code="200",http_route="\/mcp"\} 0\.2\d*$/);
    has(/^http_server_request_duration_bucket\{http_request_method="POST",http_response_status_code="200",http_route="\/mcp",le="0\.005"\} 0$/);
    has(/^http_server_request_duration_bucket\{http_request_method="POST",http_response_status_code="200",http_route="\/mcp",le="0\.25"\} 1$/);
    has(/^http_server_request_duration_bucket\{http_request_method="POST",http_response_status_code="200",http_route="\/mcp",le="\+Inf"\} 1$/);
    has('# TYPE mcp_auth_rejections_total counter');
    has(/^mcp_auth_rejections_total\{reason="unknown"\} 1$/);
    has('mcp_http_rate_limited_total 1');
    has('# UNIT mcp_tool_calls_total {call}');
    has(/^mcp_tool_calls_total\{tool="whoami",outcome="allowed",env="test"\} 1$/);
    has(/^mcp_tool_duration_count\{tool="whoami",outcome="allowed"\} 1$/);
    has(/^stralfors_requests_total\{operation="channels",outcome="error",error_type="timeout"\} 1$/);
    has(/^stralfors_request_duration_count\{operation="channels",outcome="error",error_type="timeout"\} 1$/);
    has('mcp_token_list_stale_seconds 0');
    has('target_info{service_name="stralfors-mcp",service_version="1.2.3",deployment_environment_name="test"} 1');
    expect(text).not.toContain('otel_scope');
    expect(text).not.toContain('_seconds_bucket');
    expect(text).not.toContain('le="5000"');
    expect(text).not.toContain('CANARY');
  });

  it('the exporter does not start its own server (no listen call at all)', () => {
    const listen = vi.spyOn(Server.prototype, 'listen');
    try {
      const m = memTelemetry();
      expect(m.t.metricsHandler).toBeTypeOf('function');
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
    }
  });

  it('scrape works on a bare telemetry with no in-memory reader', async () => {
    const t = createTelemetry({ serviceVersion: '0.0.0', env: 'test', sampleRatio: 1 });
    try {
      t.instruments.rateLimited.add(1);
      expect(await scrape(t)).toContain('mcp_http_rate_limited_total 1');
    } finally {
      await t.shutdown();
    }
  });
});

describe('shutdown', () => {
  it('no endpoint: spans are created, nothing is exported, shutdown completes', async () => {
    const t = createTelemetry({ serviceVersion: '0.0.0', env: 'test', sampleRatio: 1 });
    await expect(withSpan(t.tracer, 'q', SpanKind.INTERNAL, {}, async () => 1, () => 'error')).resolves.toBe(1);
    await expect(t.shutdown()).resolves.toBeUndefined();
  });

  it('is idempotent', async () => {
    const m = memTelemetry();
    await m.t.shutdown();
    await expect(m.t.shutdown()).resolves.toBeUndefined();
  });

  it('never rejects for an unreachable collector', async () => {
    const port = await closedPort();
    const t = createTelemetry({ serviceVersion: '0.0.0', env: 'test', sampleRatio: 1, otlpEndpoint: `http://127.0.0.1:${port}`, otlpTimeoutMs: 200 });
    await withSpan(t.tracer, 's', SpanKind.INTERNAL, {}, async () => 1, () => 'error');
    await expect(t.shutdown()).resolves.toBeUndefined(); // the 5 s race in start() is covered with an injected timer in main.telemetry.test.ts
    await expect(t.shutdown()).resolves.toBeUndefined();
  });

  it('exporter failure text (the endpoint) never reaches stderr or stdout', async () => {
    const port = await closedPort();
    const writes: string[] = [];
    const orig = [process.stderr.write, process.stdout.write];
    process.stderr.write = ((c: unknown) => (writes.push(String(c)), true)) as typeof process.stderr.write;
    process.stdout.write = ((c: unknown) => (writes.push(String(c)), true)) as typeof process.stdout.write;
    try {
      const t = createTelemetry({ serviceVersion: '0.0.0', env: 'test', sampleRatio: 1, otlpEndpoint: `http://127.0.0.1:${port}`, otlpTimeoutMs: 200 });
      await withSpan(t.tracer, 's', SpanKind.INTERNAL, {}, async () => 1, () => 'error');
      await t.shutdown();
    } finally {
      [process.stderr.write, process.stdout.write] = orig as [typeof process.stderr.write, typeof process.stdout.write];
    }
    expect(writes.join('')).not.toMatch(new RegExp(`${port}|ECONNREFUSED`));
  });
});

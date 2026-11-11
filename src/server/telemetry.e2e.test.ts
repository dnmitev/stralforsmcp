/*
 * R33/R34 end to end through start(): exporter output pinned, MCP port vs metrics port, trace/log/audit correlation, privacy canary over every sink.
 * Telemetry is built with in-memory seams (real Prometheus handler); the audit goes to the default destination (stdout, captured) so start()'s own wiring is what is tested.
 */
import { SpanKind } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { generateToken } from '../auth/index.ts';
import { INSTRUMENTS } from '../telemetry/instruments.ts';
import { canaries, get, hist, memTelemetry, pick, dump } from '../../test/helpers/telemetry.ts';
import { useStartWorld } from '../../test/helpers/start.ts';
import { send, INIT, MCP_HEADERS } from '../../test/helpers/server.ts';
import { json } from '../../test/helpers/api.ts';

const W = useStartWorld();
/** bounded poll: resolves when ok() holds, rejects after ~2 s */
const until = async (ok: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('until: condition not met within 200 polls');
};
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const hdr = (token: string | null, extra: Record<string, string> = {}) => ({ ...MCP_HEADERS, host: '127.0.0.1', ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...extra });

describe('exporter output (pinned as observed)', () => {
  it('a tool call and a 401 produce the documented lines; no scope labels, no ms buckets', async () => {
    const m = memTelemetry({ serviceVersion: '1.2.3' });
    const { s } = await W.boot(W.mcpEnv(), { telemetry: m.t });
    await W.call('modern', s.port, W.state.f.raw.tA, 'whoami', {});
    expect((await send(s.port, { headers: hdr(generateToken()), body: INIT })).status).toBe(401);
    const r = await get(s.metricsPort, '/metrics');
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/^text\/plain/);
    const want: (string | RegExp)[] = [
      '# UNIT http_server_request_duration s',
      '# TYPE http_server_request_duration histogram',
      /^http_server_request_duration_bucket\{http_request_method="POST",http_response_status_code="200",http_route="\/mcp",le="0\.005"\} \d+$/,
      '# TYPE mcp_auth_rejections_total counter',
      /^mcp_auth_rejections_total\{reason="unknown"\} 1$/,
      '# UNIT mcp_tool_calls_total {call}',
      /^mcp_tool_calls_total\{tool="whoami",outcome="allowed",env="test"\} 1$/,
      /^mcp_token_list_stale_seconds 0$/,
      /^target_info\{service_name="stralfors-mcp",service_version="1.2.3",deployment_environment_name="test"\} 1$/,
    ];
    const lines = r.text.split('\n');
    for (const w of want) {
      const i = lines.findIndex((l) => (typeof w === 'string' ? l === w : w.test(l)));
      expect(i, String(w)).toBeGreaterThanOrEqual(0); // family order is the exporter's (target_info, gauges, then the rest): only presence is pinned
    }
    for (const bad of ['otel_scope', '_seconds_bucket', 'le="5000"']) expect(r.text).not.toContain(bad);
  });

  it('the default build (no seams) also exports every instrument family from start()', async () => {
    const { s } = await W.boot(W.mcpEnv());
    await W.call('modern', s.port, W.state.f.raw.tA, 'list_channels', { profile: 'a' });
    await send(s.port, { headers: hdr(generateToken()), body: INIT });
    const text = (await get(s.metricsPort, '/metrics')).text;
    for (const name of ['http_server_request_duration_count', 'mcp_auth_rejections_total', 'mcp_tool_calls_total', 'mcp_tool_duration_count', 'stralfors_requests_total', 'stralfors_request_duration_count', 'mcp_token_list_stale_seconds', 'target_info']) expect(text, name).toContain(name);
    expect(text).toMatch(/^stralfors_requests_total\{operation="channels",outcome="ok"\} 1$/m);
  });

  it('the MCP port never serves metrics; the refusal is counted as an MCP-port request', async () => {
    const m = memTelemetry();
    const { s } = await W.boot(W.mcpEnv(), { telemetry: m.t });
    const r = await send(s.port, { method: 'GET', path: '/metrics', headers: { host: '127.0.0.1' } });
    expect([r.status, r.text]).toEqual([404, 'not found']);
    const post = await send(s.port, { path: '/metrics', headers: hdr(W.state.f.raw.tA), body: INIT });
    expect(post.status).toBe(404);
    expect(post.text).toBe('not found');
    await until(async () => (await m.series('http.server.request.duration')).length > 0);
    const d = await m.series('http.server.request.duration');
    expect(hist(pick(d, { 'http.request.method': 'GET', 'http.response.status_code': 404, 'http.route': '/mcp' })).count).toBe(1);
  });
});

describe('correlation across spans, logs and audit', () => {
  it('whoami: audit trace_id equals the tool span and its POST /mcp parent; no span_id in audit', async () => {
    const m = memTelemetry();
    const b = await W.boot(W.mcpEnv(), { telemetry: m.t });
    await W.call('modern', b.s.port, W.state.f.raw.tA, 'whoami', {});
    const tool = m.byName('mcp.tool whoami')[0]!;
    const parent = m.byName('POST /mcp').find((x) => x.spanContext().spanId === tool.parentSpanContext?.spanId)!;
    const line = b.audit().find((l) => l.tool === 'whoami')!;
    expect(line.trace_id).toBe(tool.spanContext().traceId);
    expect(line.trace_id).toBe(parent.spanContext().traceId);
    expect(line.trace_id).toMatch(HEX32);
    expect('span_id' in line).toBe(false);
  });

  it('401 and 429 audit lines carry the trace id of that request root span', async () => {
    const m = memTelemetry();
    const b = await W.boot(W.mcpEnv({ MCP_RATE_BURST: '1', MCP_RATE_PER_MINUTE: '1' }), { telemetry: m.t, monotonic: () => 0 });
    await send(b.s.port, { headers: hdr(generateToken()), body: INIT });
    await send(b.s.port, { headers: hdr(W.state.f.raw.tA), body: INIT });
    expect((await send(b.s.port, { headers: hdr(W.state.f.raw.tA), body: INIT })).status).toBe(429);
    const roots = m.byName('POST /mcp');
    const lines = b.audit();
    const l401 = lines.find((l) => l.reason === 'unknown')!;
    const l429 = lines.find((l) => l.reason === 'rate_limited')!;
    expect(l401.trace_id).toBe(roots.find((r) => r.attributes['error.type'] === 'unknown')!.spanContext().traceId);
    expect(l429.trace_id).toBe(roots.find((r) => r.attributes['error.type'] === 'rate_limited')!.spanContext().traceId);
  });

  it('a vendor failure keeps traceId and trace_id side by side in the audit line', async () => {
    const m = memTelemetry();
    const b = await W.boot(W.mcpEnv(), { telemetry: m.t });
    const vendor = `00-${'c'.repeat(32)}-${'d'.repeat(16)}-00`;
    W.api.reply.current = (_q, res) => json(res, 404, { message: "action id 'x' not found", traceId: vendor });
    await W.call('modern', b.s.port, W.state.f.raw.tA, 'list_channels', { profile: 'a' });
    const line = b.audit().find((l) => l.tool === 'list_channels')!;
    expect(line.reason).toBe('agreement_not_found');
    expect(line.trace_id).toMatch(HEX32);
    expect(line.trace_id).toBe(m.byName('mcp.tool list_channels')[0]!.spanContext().traceId);
    expect(line.traceId).toBe(vendor);
    expect(line.traceId).not.toBe(line.trace_id);
  });

  it('list_channels: root -> tool -> stralfors.request in one trace; the client log line carries the upstream span ids; audit and tool-level logs agree', async () => {
    const m = memTelemetry();
    const b = await W.boot(W.mcpEnv(), { telemetry: m.t });
    await W.call('modern', b.s.port, W.state.f.raw.tA, 'list_channels', { profile: 'a' });
    const root = m.byName('POST /mcp').at(-1)!;
    const tool = m.byName('mcp.tool list_channels')[0]!;
    const up = m.byName('stralfors.request')[0]!;
    expect(up.kind).toBe(SpanKind.CLIENT);
    expect(tool.parentSpanContext?.spanId).toBeDefined();
    expect(up.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(up.spanContext().traceId).toBe(tool.spanContext().traceId);
    expect(root.spanContext().traceId).toBe(tool.spanContext().traceId);
    const req = b.logs().find((l) => l.msg === 'request')!;
    expect(req.trace_id).toBe(up.spanContext().traceId);
    expect(req.span_id).toBe(up.spanContext().spanId);
    expect(String(req.trace_id)).toMatch(HEX32);
    expect(String(req.span_id)).toMatch(HEX16);
    // fake API saw no tracing headers from start()'s clients either
    for (const r of W.api.fake.requests) for (const h of ['traceparent', 'tracestate', 'baggage']) expect(r.headers, h).not.toHaveProperty(h);
  });

  it('log lines written outside any span (startup) carry neither id', async () => {
    const m = memTelemetry();
    const b = await W.boot(W.mcpEnv(), { telemetry: m.t });
    await W.call('modern', b.s.port, W.state.f.raw.tA, 'list_channels', { profile: 'a' });
    const token = b.logs().find((l) => l.msg === 'token.fetched');
    expect(token).toBeDefined();
    expect(String(token!.trace_id)).toMatch(HEX32); // the first token fetch happens inside the first upstream request
    expect(b.logs().every((l) => 'trace_id' in l === 'span_id' in l)).toBe(true);
  });

  it('a trace id is never a metric label', async () => {
    const m = memTelemetry();
    const { s } = await W.boot(W.mcpEnv(), { telemetry: m.t });
    await W.call('modern', s.port, W.state.f.raw.tA, 'list_channels', { profile: 'a' });
    const text = (await get(s.metricsPort, '/metrics')).text;
    expect(text).not.toMatch(/trace_id|span_id|traceId/);
    expect(text).not.toMatch(/="[0-9a-f]{32}"|="[0-9a-f]{16}"/);
  });
});

describe('privacy canary: every path, every sink', () => {
  it('fake token, ids and payload text appear in no span, metric label, log line or audit line', async () => {
    const m = memTelemetry();
    const c = canaries();
    const b = await W.boot(W.mcpEnv(), { telemetry: m.t });
    const A = W.state.f.raw.tA;
    W.api.reply.current = (_q, res) => json(res, 404, { message: `action id '${c.agreement}' not found for identity '${c.user}'` });
    await send(b.s.port, { headers: hdr(c.token, { 'user-agent': c.ua }), body: c.body, path: `/mcp?q=${c.query}` }); // 401
    await send(b.s.port, { headers: hdr(null, { host: `${c.path}.example.test` }), body: c.body }); // 403
    await send(b.s.port, { method: 'GET', path: `/${c.path}`, headers: { host: '127.0.0.1' } }); // 404
    await W.call('modern', b.s.port, A, 'list_channels', { profile: c.agreement }); // bad_input
    await W.call('modern', b.s.port, A, 'list_channels', { profile: 'a', agreement: c.body }); // bad_input
    await W.call('modern', b.s.port, A, 'list_channels', { profile: 'a' }); // upstream 404
    W.api.reply.current = (_q, res) => json(res, 200, ['eInvoice']);
    await W.call('modern', b.s.port, A, 'list_channels', { profile: 'a' }); // ok
    await W.call('modern', b.s.port, A, 'whoami', {});
    await new Promise((r) => setTimeout(r, 30));
    const text = (await get(b.s.metricsPort, '/metrics')).text;
    const sinks = { spans: dump(m.spans()), metrics: text, logs: b.err.join(''), audit: JSON.stringify(b.audit()) };
    const secrets = [c.token, c.user, c.agreement, c.path, c.query, c.body, c.ua, A, ...W.state.tp.secrets, W.state.tp.uuid.a, W.state.tp.uuid.b, W.state.tp.uuid.aNoLabel];
    for (const [name, text] of Object.entries(sinks)) for (const v of secrets) expect(text, `${name} has ${v.slice(0, 12)}`).not.toContain(v);
    // the end user id (a token-list id) is in the audit only
    for (const name of ['spans', 'metrics', 'logs'] as const) expect(sinks[name], name).not.toContain('"u1"');
    expect(sinks.metrics).not.toMatch(/="u1"/);
  });

  it('every label name and value in /metrics is inside the closed allowlists', async () => {
    const m = memTelemetry();
    const b = await W.boot(W.mcpEnv({ MCP_RATE_BURST: '1', MCP_RATE_PER_MINUTE: '1' }), { telemetry: m.t, monotonic: () => 0 });
    const A = W.state.f.raw.tA;
    W.api.reply.current = (_q, res) => json(res, 404, { message: "action id 'x' not found" });
    await send(b.s.port, { headers: hdr(generateToken()), body: INIT });
    await send(b.s.port, { headers: hdr(A), body: INIT }); // consumes the burst
    await send(b.s.port, { headers: hdr(A), body: INIT }); // 429
    await send(b.s.port, { method: 'GET', path: '/nope', headers: { host: '127.0.0.1' } });
    const scrape = async () => (await get(b.s.metricsPort, '/metrics')).text;
    await until(async () => { const t = await scrape(); return ['401', '200', '429', '404'].every((c) => t.includes(`http_response_status_code="${c}"`)); });
    const text = await scrape();
    const keys = new Set(Object.values(INSTRUMENTS).flatMap((i) => i.keys).map((k) => k.replaceAll('.', '_')).concat(['le']));
    const allowed: Record<string, RegExp> = {
      http_request_method: /^(GET|HEAD|POST|PUT|DELETE|OPTIONS|PATCH|CONNECT|TRACE|_OTHER)$/,
      http_response_status_code: /^(200|400|401|403|404|405|406|413|415|429|500)$/,
      http_route: /^\/mcp$/,
      reason: /^(malformed|unknown|expired|revoked)$/,
      tool: /^(whoami|list_channels)$/,
      outcome: /^(allowed|denied|error|ok)$/,
      env: /^(test|prod)$/,
      error_type: /^[a-z_]+$/,
      operation: /^(channels|raw)$/,
      le: /^(\+Inf|[0-9.]+)$/,
    };
    let seen = 0;
    for (const line of text.split('\n')) {
      if (line.startsWith('#') || line.startsWith('target_info')) continue;
      for (const [, k, v] of line.matchAll(/([a-z_]+)="([^"]*)"/g)) {
        seen++;
        expect(keys.has(k!), `label ${k}`).toBe(true);
        expect(v, `${k}=${v}`).toMatch(allowed[k!]!);
      }
    }
    expect(seen).toBeGreaterThan(20);
  });
});

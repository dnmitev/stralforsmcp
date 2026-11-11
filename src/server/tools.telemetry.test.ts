/*
 * R31 tool telemetry. API under test: RegistryDeps.telemetry / McpDeps.telemetry (src/server/tools.ts, mcp.ts).
 * callTool wraps the run in the span 'mcp.tool <name>' and records mcp.tool.calls{tool,outcome,env} and mcp.tool.duration{tool,outcome} (seconds, deps.now).
 */
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { StralforsError, TimeoutError } from '../stralfors/errors.ts';
import { ALLOWED_SPAN_KEYS } from '../telemetry/instruments.ts';
import { activeIds, withSpan } from '../telemetry/index.ts';
import { ToolInputError, callTool, type ToolDef } from './tools.ts';
import { currentPrincipal } from './context.ts';
import { startHttp } from '../../test/helpers/http-harness.ts';
import { LIST, boomTool, connect, mkDef, okTool, principal, sink, writeTool } from '../../test/helpers/server.ts';
import { canaries, hist, memTelemetry, num, pick, dump } from '../../test/helpers/telemetry.ts';
import { T } from '../../test/helpers/token-list.ts';

const dev = principal('dev', ['test']);
const setup = () => {
  const m = memTelemetry();
  const s = sink();
  let t = T;
  return { m, s, advance: (ms: number) => void (t += ms), deps: { env: 'test' as const, allowWrite: false, audit: s.audit, now: () => t, telemetry: m.t } };
};
const c = canaries();
const inputErr = mkDef('inputTool', 'read', async () => { throw new ToolInputError('fixed text'); });
const kindTool = mkDef('kindTool', 'read', async () => { throw new TimeoutError(c.msg); });
const boom = boomTool(c.msg);

const CASES: [string, ToolDef, string, 'UNSET' | 'ERROR', string | undefined, string | undefined][] = [
  ['allowed', okTool, 'allowed', 'UNSET', undefined, undefined],
  ['denied (write)', writeTool, 'denied', 'UNSET', 'write', 'write'],
  ['bad input', inputErr, 'error', 'ERROR', 'bad_input', 'bad_input'],
  ['StralforsError kind', kindTool, 'error', 'ERROR', 'timeout', 'timeout'],
  ['other throw', boom, 'error', 'ERROR', 'error', 'error'],
];

describe('five outcomes', () => {
  it.each(CASES)('%s', async (_n, def, outcome, status, errorType, auditReason) => {
    const { m, s, deps } = setup();
    await callTool(def, {}, dev, deps);
    const spans = m.byName(`mcp.tool ${def.spec.name}`);
    expect(spans).toHaveLength(1);
    const sp = spans[0]!;
    expect(sp.kind).toBe(SpanKind.INTERNAL);
    expect(sp.attributes).toEqual({ tool: def.spec.name, env: 'test', outcome, ...(errorType ? { 'error.type': errorType } : {}) });
    expect(sp.status.code).toBe(status === 'ERROR' ? SpanStatusCode.ERROR : SpanStatusCode.UNSET);
    expect(sp.status.message).toBeUndefined();
    expect(sp.events).toEqual([]);
    const calls = await m.series('mcp.tool.calls');
    expect(calls).toHaveLength(1);
    expect(num(pick(calls, { tool: def.spec.name, outcome, env: 'test' }))).toBe(1);
    const dur = await m.series('mcp.tool.duration');
    expect(dur).toHaveLength(1);
    expect(hist(pick(dur, { tool: def.spec.name, outcome })).count).toBe(1);
    // the audit semantics are unchanged
    expect(s.lines()).toHaveLength(1);
    expect(s.lines()[0]).toMatchObject({ tool: def.spec.name, outcome: outcome === 'allowed' ? 'allowed' : outcome });
    expect(s.lines()[0]!.reason).toBe(auditReason);
    expect(dump(m.spans()) + (await m.text())).not.toContain(c.msg);
  });

  it('a StralforsError subclass is an instance and its kind is the error.type (not its message)', async () => {
    const { m, deps } = setup();
    expect(new TimeoutError('x')).toBeInstanceOf(StralforsError);
    await callTool(kindTool, {}, dev, deps);
    expect(m.byName('mcp.tool kindTool')[0]!.attributes['error.type']).toBe('timeout');
  });

  it('callTool still returns a CallToolResult (the span never rejects to the SDK)', async () => {
    const { deps } = setup();
    await expect(callTool(boom, {}, dev, deps)).resolves.toMatchObject({ isError: true, content: [{ type: 'text', text: 'tool failed' }] });
  });
});

describe('duration', () => {
  it('is in seconds from the same clock as durationMs', async () => {
    const { m, s, advance, deps } = setup();
    await callTool(mkDef('slowTool', 'read', async () => (advance(120), { v: 1 })), {}, dev, deps);
    expect(s.lines()[0]!.durationMs).toBe(120);
    const [d] = await m.series('mcp.tool.duration');
    expect(hist(d).sum).toBeCloseTo(0.12, 6);
    expect(hist(d).buckets.counts[hist(d).buckets.boundaries.indexOf(0.25)]).toBe(1); // 0.1 < 0.12 <= 0.25
  });

  it('a denied call records a (near zero) duration too', async () => {
    const { m, deps } = setup();
    await callTool(writeTool, {}, dev, deps);
    expect(hist((await m.series('mcp.tool.duration'))[0]).count).toBe(1);
  });
});

describe('tree and context', () => {
  it('the tool span is a child of the active span', async () => {
    const { m, deps } = setup();
    await withSpan(m.t.tracer, 'root', SpanKind.SERVER, {}, () => callTool(okTool, {}, dev, deps), () => 'error');
    const root = m.byName('root')[0]!;
    const tool = m.byName('mcp.tool okTool')[0]!;
    expect(tool.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(tool.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  });

  it('through the HTTP front: POST /mcp -> mcp.tool whoami, one trace', async () => {
    const m = memTelemetry();
    const h = await startHttp({ telemetry: m.t, hosts: ['127.0.0.1'] });
    const r = await (await connect('modern', h.fetchFor(h.w.tA), `http://127.0.0.1:${h.port}/mcp`)).callTool({ name: 'whoami', arguments: {} });
    expect(r.isError).toBeFalsy();
    const tool = m.byName('mcp.tool whoami')[0]!;
    const parent = m.byName('POST /mcp').find((s) => s.spanContext().spanId === tool.parentSpanContext?.spanId);
    expect(parent).toBeDefined();
    expect(parent!.spanContext().traceId).toBe(tool.spanContext().traceId);
    expect(num(pick(await m.series('mcp.tool.calls'), { tool: 'whoami', outcome: 'allowed', env: 'test' }))).toBe(1);
    expect((await h.post({ body: LIST, headers: { host: '127.0.0.1' } })).status).toBe(200); // tools/list is not a tool call
    expect(m.byName('mcp.tool whoami')).toHaveLength(1);
  });

  it('principal context and active span both survive an await inside the tool, and the ids are the tool span ids', async () => {
    const { m, deps } = setup();
    let seen: unknown;
    const tool = mkDef('ctxTool', 'read', async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen = { principal: currentPrincipal(), ids: activeIds() };
      return { v: currentPrincipal() === dev && activeIds() !== undefined ? 1 : 0 };
    });
    const r = await callTool(tool, {}, dev, deps);
    expect(r.structuredContent).toEqual({ v: 1 });
    const sc = m.byName('mcp.tool ctxTool')[0]!.spanContext();
    expect((seen as { ids: unknown }).ids).toEqual({ trace_id: sc.traceId, span_id: sc.spanId });
    expect((seen as { principal: unknown }).principal).toBe(dev);
  });
});

describe('no telemetry', () => {
  it('callTool without it creates nothing anywhere', async () => {
    const bystander = memTelemetry();
    const s = sink();
    const r = await callTool(okTool, {}, dev, { env: 'test', allowWrite: false, audit: s.audit, now: () => T });
    expect(r.structuredContent).toEqual({ v: 1 });
    expect(bystander.spans()).toHaveLength(0);
    expect(await bystander.series('mcp.tool.calls')).toEqual([]);
  });
});

describe('arguments and results are nowhere', () => {
  it('canary through allowed, denied, bad_input, error paths', async () => {
    const { m, s, deps } = setup();
    const echo = mkDef('echoTool', 'read', async (a) => ({ v: 1, note: (a as { note?: string }).note ?? '' }));
    for (const def of [echo, writeTool, inputErr, boom]) await callTool(def, { note: c.body, agreement: c.agreement, path: c.path }, dev, deps);
    const spans = dump(m.spans());
    const text = await m.text();
    for (const v of [c.body, c.agreement, c.path, c.msg]) {
      expect(spans, v).not.toContain(v);
      expect(text, v).not.toContain(v);
    }
    expect(JSON.stringify(s.lines())).not.toContain(c.body);
    for (const sp of m.spans()) for (const k of Object.keys(sp.attributes)) expect(ALLOWED_SPAN_KEYS.has(k), k).toBe(true);
    expect(m.spans()).toHaveLength(4);
  });
});

describe('tool span when the audit sink itself throws', () => {
  it('error.type is the fixed "error"', async () => {
    const { m, deps } = setup();
    const bad = { ...deps, audit: { record: () => { throw new Error('sink'); } } as never };
    await callTool(okTool, {}, dev, bad).catch(() => undefined);
    expect(m.byName('mcp.tool okTool')[0]?.attributes['error.type']).toBe('error');
  });
});

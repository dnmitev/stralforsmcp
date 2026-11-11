// Mutation-kill tests for telemetry.ts (gauge metadata, upstream duration unit, status code rule, shutdown ownership).
import { SpanKind } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { ConfigError, StralforsError } from '../stralfors/errors.ts';
import { memTelemetry, hist, pick, scrape } from '../../test/helpers/telemetry.ts';
import { upstreamInstrument, withSpan, activeIds } from './index.ts';

const info = { operation: 'op', method: 'GET' } as never;
const rawErr = (status: unknown) => Object.assign(new Error('x'), { status });

describe('telemetry kill tests', () => {
  it('stale gauge: described, unit-suffixed, and 0 until observeStale is wired', async () => {
    const m = memTelemetry();
    const text = await scrape(m.t);
    expect(text).toContain('# HELP mcp_token_list_stale_seconds Seconds the token list has been served');
    expect(text).toMatch(/^mcp_token_list_stale_seconds 0$/m);
    m.t.instruments.observeStale(() => 2500);
    expect(await scrape(m.t)).toMatch(/^mcp_token_list_stale_seconds 2\.5$/m);
  });

  it('upstream duration is recorded in seconds, elapsed time only', async () => {
    const m = memTelemetry();
    await upstreamInstrument(m.t)(info, () => new Promise((r) => setTimeout(() => r(1), 30)));
    const h = hist(pick(await m.series('stralfors.request.duration'), { operation: 'op', outcome: 'ok' }));
    expect(h.sum).toBeGreaterThan(0.02);
    expect(h.sum).toBeLessThan(2);
  });

  it('status code only for a StralforsError with a numeric status', async () => {
    const m = memTelemetry();
    const run = (e: unknown) => upstreamInstrument(m.t)(info, async () => { throw e; }).catch(() => undefined);
    await run(new StralforsError('upstream', 'x', { status: 503 }));
    await run(new StralforsError('timeout', 'x'));
    await run(rawErr(404));
    await run(rawErr(undefined));
    const codes = m.spans().map((s) => s.attributes['http.response.status_code']);
    expect(codes).toEqual([503, undefined, undefined, undefined]);
    expect(m.t.droppedKeys).toBe(0);
  });

  it('shutdown stops the providers: later spans are not exported', async () => {
    const m = memTelemetry();
    await m.t.shutdown();
    await withSpan(m.t.tracer, 'late', SpanKind.INTERNAL, {}, async () => 1, () => 'error');
    expect(m.byName('late')).toHaveLength(0);
  });

  it('the shared context manager outlives a first shutdown and goes with the last', async () => {
    const a = memTelemetry();
    const b = memTelemetry();
    await a.t.shutdown();
    await withSpan(b.t.tracer, 'p', SpanKind.INTERNAL, {}, async () => { expect(activeIds()).toBeDefined(); }, () => 'error');
    await b.t.shutdown();
    await withSpan(memTelemetry().t.tracer, 'q', SpanKind.INTERNAL, {}, async () => { expect(activeIds()).toBeDefined(); }, () => 'error');
  });

  it('ConfigError (no status) still maps to its kind', async () => {
    const m = memTelemetry();
    await upstreamInstrument(m.t)(info, async () => { throw new ConfigError('x'); }).catch(() => undefined);
    expect(m.spans()[0]!.attributes['error.type']).toBe('config');
  });
});

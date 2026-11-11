import type { IncomingMessage, ServerResponse } from 'node:http';
import { context, SpanKind, SpanStatusCode, trace, type Attributes, type Counter, type Histogram, type Meter, type Span, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, createAllowListAttributesProcessor, type MetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, ParentBasedSampler, SimpleSpanProcessor, TraceIdRatioBasedSampler, TracerProvider, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace';
import type { AuditReason } from '../audit/index.ts';
import { StralforsError } from '../stralfors/errors.ts';
import type { CreateClientOptions } from '../stralfors/index.ts';
import { ALLOWED_SPAN_KEYS, INSTRUMENTS, METHOD_LABEL } from './instruments.ts';

export const SERVICE_NAME = 'stralfors-mcp';

export interface TelemetryOptions {
  serviceVersion: string;
  env: 'test' | 'prod';
  /** root sampler ratio, 0..1 */
  sampleRatio: number;
  /** undefined or '' = spans are created, never exported */
  otlpEndpoint?: string;
  /** test seams */
  spanExporter?: SpanExporter;
  metricReader?: MetricReader;
  otlpTimeoutMs?: number;
}
export interface Instruments {
  httpDuration: Histogram; authRejections: Counter; rateLimited: Counter; toolCalls: Counter; toolDuration: Histogram;
  upstreamRequests: Counter; upstreamDuration: Histogram;
  /** the gauge callback reads this source in seconds; a later call replaces the source */
  observeStale(staleMs: () => number): void;
}
export interface Telemetry {
  tracer: Tracer;
  meter: Meter;
  instruments: Instruments;
  metricsHandler(req: IncomingMessage, res: ServerResponse): void;
  /** attribute keys refused by setSafe since this telemetry was created */
  readonly droppedKeys: number;
  shutdown(): Promise<void>;
}

// Global context manager ownership: one shared manager, reference counted. Each createTelemetry registers it (a no-op returning false
// if it is already registered); the last shutdown disables it, so a later createTelemetry can register again.
// ponytail: a telemetry that is never shut down keeps the manager alive for the process; fine, the process owns one.
let shared: AsyncLocalStorageContextManager | undefined;
let owners = 0;
let registered = false; // true only while this module's manager is the global one; never disable another SDK's
let dropped = 0; // ponytail: process-wide counter; droppedKeys reports the delta since creation, exact while one telemetry lives

/** Sets only keys in ALLOWED_SPAN_KEYS; drops and counts the rest. */
export function setSafe(span: Span, attrs: Attributes): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (ALLOWED_SPAN_KEYS.has(k)) span.setAttribute(k, v as never);
    else dropped++;
  }
}

/** Active span around fn; on throw: status ERROR, fixed error.type, rethrow. No exception event, no message. */
export function withSpan<T>(tracer: Tracer, name: string, kind: SpanKind, attrs: Attributes, fn: (span: Span) => Promise<T>, errorType: (e: unknown) => AuditReason): Promise<T> {
  return tracer.startActiveSpan(name, { kind, root: kind === SpanKind.SERVER }, async (span) => {
    setSafe(span, attrs);
    try {
      return await fn(span);
    } catch (e) {
      setSafe(span, { 'error.type': errorType(e) });
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Ids of the active span (sampled or not) or undefined. */
export function activeIds(): { trace_id: string; span_id: string } | undefined {
  const c = trace.getActiveSpan()?.spanContext();
  return c && trace.isSpanContextValid(c) ? { trace_id: c.traceId, span_id: c.spanId } : undefined;
}
export const logMixin = (): Record<string, string> => activeIds() ?? {};

export function createTelemetry(o: TelemetryOptions): Telemetry {
  shared ??= new AsyncLocalStorageContextManager().enable();
  owners++;
  registered ||= context.setGlobalContextManager(shared);
  const baseline = dropped;

  const resource = resourceFromAttributes({ 'service.name': SERVICE_NAME, 'service.version': o.serviceVersion, 'deployment.environment.name': o.env });
  const spanProcessors: SpanProcessor[] = o.spanExporter
    ? [new SimpleSpanProcessor({ exporter: o.spanExporter })]
    : o.otlpEndpoint
      ? [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${o.otlpEndpoint.replace(/\/$/, '')}/v1/traces`, timeoutMillis: o.otlpTimeoutMs ?? 2000 }) })]
      : [];
  const tracerProvider = new TracerProvider({ resource, sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(o.sampleRatio) }), spanProcessors });

  // the built-in server is never used: its port 0 falls back to 9464 and it answers POST
  const prometheus = new PrometheusExporter({ preventServerStart: true, withoutScopeInfo: true });
  const meterProvider = new MeterProvider({
    resource,
    readers: [prometheus, ...(o.metricReader ? [o.metricReader] : [])],
    views: Object.values(INSTRUMENTS).map((i) => ({ instrumentName: i.name, attributesProcessors: [createAllowListAttributesProcessor([...i.keys])] })),
  });
  const tracer = tracerProvider.getTracer(SERVICE_NAME);
  const meter = meterProvider.getMeter(SERVICE_NAME);
  const make = <K extends keyof typeof INSTRUMENTS>(k: K) => {
    const s = INSTRUMENTS[k] as { name: string; unit: string; description: string; buckets?: readonly number[] };
    return s.buckets
      ? meter.createHistogram(s.name, { unit: s.unit, description: s.description, advice: { explicitBucketBoundaries: [...s.buckets] } })
      : meter.createCounter(s.name, { unit: s.unit, description: s.description });
  };
  let stale: () => number = () => 0;
  const g = INSTRUMENTS.staleSeconds;
  meter.createObservableGauge(g.name, { unit: g.unit, description: g.description }).addCallback((r) => r.observe(stale() / 1000));

  const instruments: Instruments = {
    httpDuration: make('httpDuration') as Histogram, authRejections: make('authRejections') as Counter, rateLimited: make('rateLimited') as Counter,
    toolCalls: make('toolCalls') as Counter, toolDuration: make('toolDuration') as Histogram,
    upstreamRequests: make('upstreamRequests') as Counter, upstreamDuration: make('upstreamDuration') as Histogram,
    observeStale: (fn) => void (stale = fn),
  };

  let closing: Promise<void> | undefined;
  return {
    tracer, meter, instruments,
    metricsHandler: (req, res) => prometheus.getMetricsRequestHandler(req, res),
    get droppedKeys() { return dropped - baseline; },
    // exporter failures are swallowed (their text carries the endpoint); the only observable failure is time, which start() bounds
    shutdown: () => (closing ??= (async () => {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]).catch(() => undefined);
      if (--owners === 0) {
        if (registered) context.disable();
        registered = false;
        shared?.disable();
        shared = undefined;
      }
    })()),
  };
}

const kindOf = (e: unknown): AuditReason => (e instanceof StralforsError ? e.kind : 'error');

/** The `instrument` hook of createClient: one CLIENT span and the upstream metrics per request. Never a path, query or id. */
export function upstreamInstrument(t: Telemetry): NonNullable<CreateClientOptions['instrument']> {
  return (info, run) =>
    withSpan<unknown>(t.tracer, 'stralfors.request', SpanKind.CLIENT, { 'stralfors.operation': info.operation, 'http.request.method': METHOD_LABEL(info.method) }, async (span) => {
      const t0 = performance.now();
      let a: Attributes = { operation: info.operation, outcome: 'ok' };
      try {
        return await run();
      } catch (e) {
        a = { operation: info.operation, outcome: 'error', 'error.type': kindOf(e) };
        if (e instanceof StralforsError && typeof e.status === 'number') setSafe(span, { 'http.response.status_code': e.status });
        throw e;
      } finally {
        t.instruments.upstreamRequests.add(1, a);
        t.instruments.upstreamDuration.record((performance.now() - t0) / 1000, a);
      }
    }, kindOf);
}

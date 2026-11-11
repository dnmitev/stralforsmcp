// Telemetry test seams: in-memory span exporter + in-memory metric reader, a scrape helper, and global OTel cleanup between tests.
// Every telemetry made here is shut down after each test and the global OTel state is disabled, so no test sees another one's context manager.
import { createServer, request } from 'node:http';
import { afterEach } from 'vitest';
import { context, metrics, trace } from '@opentelemetry/api';
import { AggregationTemporality, InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { createTelemetry, type Telemetry, type TelemetryOptions } from '../../src/telemetry/index.ts';

const made: Telemetry[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((t) => t.shutdown().catch(() => undefined)));
  context.disable();
  trace.disable();
  metrics.disable();
});

export interface Series { attributes: Record<string, unknown>; value: unknown }
export interface MemTelemetry {
  t: Telemetry;
  exporter: InMemorySpanExporter;
  /** finished spans in end order */
  spans: () => ReadableSpan[];
  byName: (name: string) => ReadableSpan[];
  /** flushes the reader and returns the data points of one metric (cumulative); [] if it has none */
  series: (name: string) => Promise<Series[]>;
  /** Prometheus text from t.metricsHandler */
  text: () => Promise<string>;
}

export function memTelemetry(over: Partial<TelemetryOptions> = {}): MemTelemetry {
  const exporter = new InMemorySpanExporter();
  const mx = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter: mx, exportIntervalMillis: 3_600_000 });
  const t = createTelemetry({ serviceVersion: '0.0.0', env: 'test', sampleRatio: 1, spanExporter: exporter, metricReader: reader, ...over });
  made.push(t);
  return {
    t,
    exporter,
    spans: () => exporter.getFinishedSpans(),
    byName: (name) => exporter.getFinishedSpans().filter((s) => s.name === name),
    series: async (name) => {
      await reader.forceFlush();
      const last = mx.getMetrics().at(-1);
      const m = last?.scopeMetrics.flatMap((s) => s.metrics).find((x) => x.descriptor.name === name);
      return (m?.dataPoints ?? []).map((d) => ({ attributes: { ...d.attributes }, value: d.value }));
    },
    text: () => scrape(t),
  };
}

/** GET /metrics through the telemetry's own handler on a throw-away listener. */
export async function scrape(t: Telemetry): Promise<string> {
  const srv = createServer((req, res) => t.metricsHandler(req, res));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { port } = srv.address() as { port: number };
    return (await get(port, '/metrics')).text;
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

export interface Got { status: number; type: string; text: string }
export const get = (port: number, path: string, method = 'GET', host = '127.0.0.1'): Promise<Got> =>
  new Promise((resolve, reject) => {
    const req = request({ host, port, path, method, agent: false }, (res) => {
      const bufs: Buffer[] = [];
      res.on('data', (b: Buffer) => bufs.push(b));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), text: Buffer.concat(bufs).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });

/** The value of one series as a plain number (counter / gauge) */
export const num = (s: Series | undefined): number | undefined => (s === undefined ? undefined : (s.value as number));
export interface Hist { count: number; sum: number; buckets: { boundaries: number[]; counts: number[] } }
export const hist = (s: Series | undefined): Hist => s!.value as Hist;
/** find the series whose attributes equal `attrs` exactly */
export const pick = (all: Series[], attrs: Record<string, unknown>): Series | undefined => all.find((s) => JSON.stringify(sorted(s.attributes)) === JSON.stringify(sorted(attrs)));
const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Values that must appear in no span, metric label, log line or audit line. Built at run time so scanners stay quiet. */
export const canaries = () => {
  const r = () => Math.random().toString(16).slice(2, 10);
  return { token: `TOKEN-CANARY-${r()}`, user: `USER-CANARY-${r()}`, agreement: `AGREEMENT-CANARY-${r()}`, path: `PATH-CANARY-${r()}`, query: `QUERY-CANARY-${r()}`, body: `BODY-CANARY-${r()}`, ua: `UA-CANARY-${r()}`, msg: `MSG-CANARY-${r()}`, method: `XCANARY${r()}`.toUpperCase() };
};

/** Plain-JSON view of finished spans (ReadableSpan itself is circular). */
export const dump = (spans: ReadableSpan[]): string =>
  JSON.stringify(spans.map((s) => ({ name: s.name, kind: s.kind, attributes: s.attributes, events: s.events, links: s.links, status: s.status, resource: s.resource.attributes, parent: s.parentSpanContext, ctx: s.spanContext() })));

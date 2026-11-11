/* R28 exporter wiring with the OTLP exporter mocked: no endpoint, no exporter; an endpoint gives <endpoint>/v1/traces and the timeout. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const ctor = vi.hoisted(() => vi.fn());
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    constructor(o: unknown) {
      ctor(o);
    }
    export(_s: unknown, cb: (r: { code: number }) => void) { cb({ code: 0 }); }
    shutdown() { return Promise.resolve(); }
    forceFlush() { return Promise.resolve(); }
  },
}));

import { context, metrics, trace } from '@opentelemetry/api';
import { createTelemetry, type Telemetry } from './index.ts';

const made: Telemetry[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((t) => t.shutdown()));
  context.disable();
  trace.disable();
  metrics.disable();
  ctor.mockClear();
});
const make = (o: Partial<Parameters<typeof createTelemetry>[0]> = {}) => {
  const t = createTelemetry({ serviceVersion: '0.0.0', env: 'test', sampleRatio: 1, ...o });
  made.push(t);
  return t;
};

describe('OTLP exporter wiring', () => {
  it.each([[undefined], ['']])('endpoint %j: the exporter is never constructed', (endpoint) => {
    make({ otlpEndpoint: endpoint });
    expect(ctor).not.toHaveBeenCalled();
  });

  it('an endpoint gets the traces path and the default 2000 ms timeout', () => {
    make({ otlpEndpoint: 'http://collector.example.test:4318' });
    expect(ctor).toHaveBeenCalledExactlyOnceWith({ url: 'http://collector.example.test:4318/v1/traces', timeoutMillis: 2000 });
  });

  it('exactly one trailing slash is stripped', () => {
    make({ otlpEndpoint: 'http://collector.example.test:4318/' });
    expect(ctor).toHaveBeenCalledExactlyOnceWith({ url: 'http://collector.example.test:4318/v1/traces', timeoutMillis: 2000 });
  });

  it('otlpTimeoutMs is passed through', () => {
    make({ otlpEndpoint: 'https://c.example.test', otlpTimeoutMs: 123 });
    expect(ctor).toHaveBeenCalledExactlyOnceWith({ url: 'https://c.example.test/v1/traces', timeoutMillis: 123 });
  });

  it('a spanExporter seam replaces the OTLP exporter even with an endpoint', () => {
    make({ otlpEndpoint: 'http://collector.example.test:4318', spanExporter: { export: (_s, cb) => cb({ code: 0 }), shutdown: async () => undefined } });
    expect(ctor).not.toHaveBeenCalled();
  });
});

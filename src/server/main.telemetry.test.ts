/*
 * R29 bootstrap with telemetry. API under test (src/server/main.ts): env rows MCP_METRICS_PORT / MCP_METRICS_HOST / MCP_TRACE_SAMPLE_RATIO / OTEL_EXPORTER_OTLP_ENDPOINT,
 * StartDeps { telemetry?, timer? }, Started { port, metricsPort, close }, TELEMETRY_FLUSH_MS, close order, metrics listener lifecycle.
 * The default metrics port 9464 is never bound: the listen spy rewrites it to 0.
 */
import { readFileSync } from 'node:fs';
import { Server } from 'node:http';
import { createConnection } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { serverInfo } from '../server-info.ts';
import { ConfigError } from '../stralfors/errors.ts';
import * as telemetryModule from '../telemetry/index.ts';
import { TELEMETRY_FLUSH_MS } from './main.ts';
import { get, memTelemetry } from '../../test/helpers/telemetry.ts';
import { freePort, useStartWorld } from '../../test/helpers/start.ts';
import { T } from '../../test/helpers/token-list.ts';

vi.mock('../telemetry/index.ts', async (orig) => {
  const a = await orig<typeof import('../telemetry/index.ts')>();
  return { ...a, createTelemetry: vi.fn(a.createTelemetry) };
});
const createTelemetry = vi.mocked(telemetryModule.createTelemetry);

const W = useStartWorld();
const refused = (port: number) => new Promise<boolean>((resolve) => {
  const s = createConnection({ port, host: '127.0.0.1' });
  s.once('error', () => resolve(true));
  s.once('connect', () => (s.destroy(), resolve(false)));
});
interface Listen { port: unknown; host: unknown; server: Server }
/** records every listen() and (optionally) rewrites the default metrics port so 9464 is never bound */
const spyListen = (rewrite9464 = false) => {
  const calls: Listen[] = [];
  const orig = Server.prototype.listen as (...a: unknown[]) => Server;
  vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: unknown[]) {
    const o = typeof args[0] === 'object' && args[0] !== null ? (args[0] as { port?: unknown; host?: unknown }) : { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
    calls.push({ port: o.port, host: o.host, server: this });
    if (rewrite9464 && o.port === 9464) {
      const fn = args.find((a) => typeof a === 'function');
      return orig.call(this, 0, '127.0.0.1', ...(fn ? [fn] : []));
    }
    return orig.apply(this, args);
  } as never);
  return calls;
};
const portOf = (s: Server) => (s.address() as { port: number } | null)?.port;

describe('constants', () => {
  it('the telemetry flush bound is 5 s', () => {
    expect(TELEMETRY_FLUSH_MS).toBe(5000);
  });
});

describe('env validation', () => {
  it.each([
    ['MCP_METRICS_PORT', '65536'], ['MCP_METRICS_PORT', '-1'], ['MCP_METRICS_PORT', '9464x'], ['MCP_METRICS_PORT', '1.5'], ['MCP_METRICS_PORT', ''],
    ['MCP_METRICS_HOST', ''], ['MCP_METRICS_HOST', '   '],
    ['MCP_TRACE_SAMPLE_RATIO', '1.5'], ['MCP_TRACE_SAMPLE_RATIO', '-0.1'], ['MCP_TRACE_SAMPLE_RATIO', 'abc'], ['MCP_TRACE_SAMPLE_RATIO', '1e-1'], ['MCP_TRACE_SAMPLE_RATIO', ' 0.5'], ['MCP_TRACE_SAMPLE_RATIO', '50%'], ['MCP_TRACE_SAMPLE_RATIO', '1.1'], ['MCP_TRACE_SAMPLE_RATIO', ''],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'collector:4318'], ['OTEL_EXPORTER_OTLP_ENDPOINT', 'ftp://c.example.test'], ['OTEL_EXPORTER_OTLP_ENDPOINT', 'not a url'], ['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://c.example.test:4318/x?a=b'], ['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://c.example.test:4318#f'], ['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://c.example.test:4318?'],
  ])('%s=%j: ConfigError "<name> is invalid" and nothing was touched', async (name, value) => {
    const env = W.mcpEnv({ [name]: value });
    const readFile = vi.fn(() => '');
    const clientFactory = vi.fn();
    const listen = spyListen();
    createTelemetry.mockClear();
    const e = await W.boot(env, { readFile, clientFactory }).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toBe(`${name} is invalid`);
    expect(readFile).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
    expect(listen).toHaveLength(0);
    expect(createTelemetry).not.toHaveBeenCalled();
  });

  it.each([['0', 0], ['1', 1], ['.5', 0.5], ['0.0', 0], ['1.0', 1], ['0.25', 0.25]])('MCP_TRACE_SAMPLE_RATIO %j is accepted as %d', async (v, n) => {
    createTelemetry.mockClear();
    await W.boot(W.mcpEnv({ MCP_TRACE_SAMPLE_RATIO: v }));
    expect(createTelemetry.mock.calls[0]![0].sampleRatio).toBe(n);
  });

  it('an empty OTEL_EXPORTER_OTLP_ENDPOINT behaves as unset; a valid one is passed as given', async () => {
    createTelemetry.mockClear();
    await W.boot(W.mcpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: '' }));
    expect(createTelemetry.mock.calls[0]![0].otlpEndpoint || undefined).toBeUndefined();
    createTelemetry.mockClear();
    await W.boot(W.mcpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.test:4318' }));
    expect(createTelemetry.mock.calls[0]![0].otlpEndpoint).toBe('http://collector.example.test:4318');
  });
});

describe('OTLP credentials stay off cleartext links', () => {
  it.each(['OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS'])('%s with a non-loopback http endpoint: ConfigError, nothing started', async (h) => {
    createTelemetry.mockClear();
    const e = await W.boot(W.mcpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.test:4318', [h]: 'authorization=Bearer CANARY-SECRET' })).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toBe('OTEL_EXPORTER_OTLP_ENDPOINT must be https when OTLP headers are set');
    expect(createTelemetry).not.toHaveBeenCalled();
  });

  it.each(['https://collector.example.test:4318', 'http://127.0.0.1:4318', 'http://localhost:4318', 'http://[::1]:4318'])('%s with headers is accepted', async (url) => {
    createTelemetry.mockClear();
    await W.boot(W.mcpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: url, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=x' }));
    expect(createTelemetry.mock.calls[0]![0].otlpEndpoint).toBe(url);
  });

  it.each(['OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS'])('%s set only on process.env (the exporter reads it there): ConfigError, nothing started', async (h) => {
    createTelemetry.mockClear();
    const prev = process.env[h];
    process.env[h] = 'authorization=Bearer CANARY-SECRET';
    try {
      const e = await W.boot(W.mcpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.test:4318' })).then(() => undefined, (x: unknown) => x);
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toBe('OTEL_EXPORTER_OTLP_ENDPOINT must be https when OTLP headers are set');
      expect(createTelemetry).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env[h];
      else process.env[h] = prev;
    }
  });

  it('http without headers is still accepted', async () => {
    createTelemetry.mockClear();
    await W.boot(W.mcpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.test:4318' }));
    expect(createTelemetry).toHaveBeenCalledTimes(1);
  });
});

describe('metrics listener request targets', () => {
  it('a malformed target (//) gets a fixed 400 and the listener keeps serving', async () => {
    const m = memTelemetry();
    const { s } = await W.boot(W.mcpEnv(), { telemetry: m.t });
    const r = await get(s.metricsPort, '//');
    expect([r.status, r.text]).toEqual([400, 'bad request']);
    expect((await get(s.metricsPort, '/metrics')).status).toBe(200);
  });
});

describe('defaults', () => {
  it('createTelemetry gets ratio 0.1, no endpoint, the deploy env and the server version; metrics listen on 0.0.0.0:9464', async () => {
    const calls = spyListen(true);
    createTelemetry.mockClear();
    const env = W.mcpEnv({ MCP_METRICS_PORT: undefined, MCP_METRICS_HOST: undefined });
    await W.boot(env);
    const o = createTelemetry.mock.calls[0]![0];
    expect([o.sampleRatio, o.otlpEndpoint, o.env, o.serviceVersion]).toEqual([0.1, undefined, 'test', serverInfo.version]);
    expect(createTelemetry).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect([calls[0]!.port, calls[0]!.host]).toEqual([9464, '0.0.0.0']);
  });

  it('prod deploys label the resource prod', async () => {
    createTelemetry.mockClear();
    await W.boot(W.mcpEnv({ STRALFORS_ENV: 'prod' }));
    expect(createTelemetry.mock.calls[0]![0].env).toBe('prod');
  });

  it('the given metrics host and port are used', async () => {
    const calls = spyListen();
    const port = await freePort();
    await W.boot(W.mcpEnv({ MCP_METRICS_PORT: String(port) }));
    expect([calls[0]!.port, calls[0]!.host]).toEqual([port, '127.0.0.1']);
  });
});

describe('metrics listener lifecycle', () => {
  it('listens before the HTTP listener on its own port and serves /metrics there', async () => {
    const calls = spyListen();
    const { s } = await W.boot(W.mcpEnv());
    expect(calls).toHaveLength(2);
    expect(portOf(calls[0]!.server)).toBe(s.metricsPort);
    expect(portOf(calls[1]!.server)).toBe(s.port);
    expect(s.metricsPort).toBeGreaterThan(0);
    expect(s.metricsPort).not.toBe(s.port);
    const r = await get(s.metricsPort, '/metrics');
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/^text\/plain/);
  });

  it('the metrics port serves only GET /metrics; the rest is a plain 404', async () => {
    const { s } = await W.boot(W.mcpEnv());
    for (const [m, p] of [['POST', '/metrics'], ['GET', '/'], ['GET', '/mcp'], ['GET', '/metrics/x'], ['PUT', '/metrics']] as const) {
      const r = await get(s.metricsPort, p, m);
      expect([m, p, r.status, r.text]).toEqual([m, p, 404, 'not found']);
    }
  });

  it('a query string on /metrics is accepted (scrapers add params)', async () => {
    const { s } = await W.boot(W.mcpEnv());
    expect((await get(s.metricsPort, '/metrics?x=1')).status).toBe(200);
  });

  it('the MCP port answers 404 for /metrics', async () => {
    const { s } = await W.boot(W.mcpEnv());
    const r = await get(s.port, '/metrics');
    expect([r.status, r.text]).toEqual([404, 'not found']);
  });

  it('a metrics bind failure refuses to start with fixed text and leaves nothing open', async () => {
    const taken = new Server();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    const port = portOf(taken)!;
    try {
      const order: string[] = [];
      const clients = { a: W.stub('a', order), b: W.stub('b', order) };
      const m = memTelemetry({ metricReader: undefined }); // no periodic reader: its interval would also hit the clearInterval spy
      const shutdown = vi.spyOn(m.t, 'shutdown');
      const clear = vi.spyOn(globalThis, 'clearInterval');
      const calls = spyListen();
      const e = await W.boot(W.mcpEnv({ MCP_METRICS_PORT: String(port) }), { clientFactory: (o) => clients[o.profileId as 'a' | 'b'], telemetry: m.t }).then(() => undefined, (x: unknown) => x);
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toBe('metrics listener failed');
      expect((e as Error).message).not.toContain(String(port));
      expect(JSON.stringify(e)).not.toContain(String(port));
      expect(clients.a.close).toHaveBeenCalledTimes(1);
      expect(clients.b.close).toHaveBeenCalledTimes(1);
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1); // the MCP port was never listened on
      expect(calls[0]!.port).toBe(port);
      const again = await W.boot(W.mcpEnv()); // nothing leaked: a fresh start works
      expect(again.s.metricsPort).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => taken.close(() => r()));
    }
  });

  it('an HTTP bind failure closes the metrics listener again', async () => {
    const taken = new Server();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    const metrics = await freePort();
    try {
      const m = memTelemetry();
      const shutdown = vi.spyOn(m.t, 'shutdown');
      await expect(W.boot(W.mcpEnv({ MCP_PORT: String(portOf(taken)), MCP_METRICS_PORT: String(metrics) }), { telemetry: m.t })).rejects.toThrow();
      expect(await refused(metrics)).toBe(true);
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((r) => taken.close(() => r()));
    }
  });

  it('a failure while building the clients also shuts telemetry down and closes the store', async () => {
    const m = memTelemetry({ metricReader: undefined });
    const shutdown = vi.spyOn(m.t, 'shutdown');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const calls = spyListen();
    await expect(W.boot(W.mcpEnv(), { telemetry: m.t, clientFactory: () => { throw new Error('factory failed'); } })).rejects.toThrow('factory failed');
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});

describe('close order', () => {
  const orderWorld = async (extra: Parameters<typeof W.boot>[1] = {}) => {
    const order: string[] = [];
    const m = memTelemetry({ metricReader: undefined });
    const sd = m.t.shutdown.bind(m.t);
    vi.spyOn(m.t, 'shutdown').mockImplementation(async () => (order.push('telemetry'), sd()));
    const clients = { a: W.stub('a', order), b: W.stub('b', order) };
    const orig = clearInterval;
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((h: never) => (order.push('store'), orig(h))) as never);
    const closeOf = Server.prototype.close;
    let ports: { mcp?: number; metrics?: number } = {};
    vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, cb?: (e?: Error) => void) {
      const p = portOf(this);
      if (p !== undefined) order.push(p === ports.metrics ? 'close metrics' : p === ports.mcp ? 'close mcp' : `close ${p}`);
      return closeOf.call(this, cb);
    });
    let signal!: () => void;
    const b = await W.boot(W.mcpEnv(), { clientFactory: (o) => clients[o.profileId as 'a' | 'b'], telemetry: m.t, onSignal: (fn) => void (signal = fn), ...extra });
    ports = { mcp: b.s.port, metrics: b.s.metricsPort };
    return { ...b, order, signal, m, clients };
  };
  const withExitCode = async (fn: () => Promise<void>) => {
    const prev = process.exitCode;
    process.exitCode = 5;
    try {
      await fn();
    } finally {
      process.exitCode = prev;
    }
  };

  it('HTTP drain -> clients in order -> metrics listener -> telemetry -> store; exit code 0', async () => {
    const w = await orderWorld();
    await withExitCode(async () => {
      w.signal();
      await w.s.close();
      expect(process.exitCode).toBe(0);
    });
    expect(w.order).toEqual(['close mcp', 'close a', 'close b', 'close metrics', 'telemetry', 'store']);
    expect(await refused(w.s.metricsPort)).toBe(true);
    expect(await refused(w.s.port)).toBe(true);
  });

  it('readiness flips to 503 before anything else is closed', async () => {
    const w = await orderWorld();
    w.signal();
    const r = await get(w.s.port, '/readyz').then((x) => x.status, () => 503);
    expect(r).toBe(503);
    await w.s.close();
  });

  it('a client close failure still shuts telemetry down and closes the store; close rejects "client close failed"; exit 1', async () => {
    const order: string[] = [];
    const m = memTelemetry();
    const sd = m.t.shutdown.bind(m.t);
    vi.spyOn(m.t, 'shutdown').mockImplementation(async () => (order.push('telemetry'), sd()));
    const bad = { close: vi.fn(async () => { throw new Error('x'); }) } as never;
    let signal!: () => void;
    const { s } = await W.boot(W.mcpEnv(), { clientFactory: () => bad, telemetry: m.t, onSignal: (fn) => void (signal = fn) });
    await withExitCode(async () => {
      signal();
      await expect(s.close()).rejects.toThrow('client close failed');
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
    });
    expect(order).toEqual(['telemetry']);
  });

  it('a hanging telemetry shutdown is bounded by the injected timer: close rejects after the store closed, exit 1, same promise on a second call', async () => {
    const order: string[] = [];
    const m = memTelemetry();
    vi.spyOn(m.t, 'shutdown').mockImplementation(() => new Promise<void>(() => undefined));
    const orig = clearInterval;
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((h: never) => (order.push('store'), orig(h))) as never);
    const ms: number[] = [];
    const timer = ((fn: () => void, n: number) => (ms.push(n), queueMicrotask(fn), { unref: () => undefined, ref: () => undefined, hasRef: () => false })) as unknown as typeof setTimeout;
    let signal!: () => void;
    const { s } = await W.boot(W.mcpEnv(), { telemetry: m.t, timer, onSignal: (fn: () => void) => void (signal = fn) } as never);
    await withExitCode(async () => {
      signal();
      const p1 = s.close();
      expect(s.close()).toBe(p1);
      await expect(p1).rejects.toThrow('telemetry shutdown failed');
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
    });
    expect(order).toEqual(['store']);
    expect(ms).toContain(TELEMETRY_FLUSH_MS);
  });

  it('a rejecting telemetry shutdown also reports "telemetry shutdown failed" after the store closed', async () => {
    const m = memTelemetry();
    vi.spyOn(m.t, 'shutdown').mockRejectedValue(new Error('MSG-CANARY 127.0.0.1:9'));
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const { s } = await W.boot(W.mcpEnv(), { telemetry: m.t });
    const e = await s.close().then(() => undefined, (x: unknown) => x);
    expect((e as Error).message).toBe('telemetry shutdown failed');
    expect(clear).toHaveBeenCalled();
  });
});

describe('telemetry failure does not touch readiness or output', () => {
  it('an unreachable collector: /readyz stays 200, tool results are normal, no line names the endpoint', async () => {
    const port = await freePort();
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => (writes.push(String(c)), true)) as typeof process.stderr.write);
    const b = await W.boot(W.mcpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`, MCP_TRACE_SAMPLE_RATIO: '1' }));
    const r = await W.call('modern', b.s.port, W.state.f.raw.tA, 'list_channels', { profile: 'a' });
    expect(r.structuredContent).toEqual({ profile: 'a', channels: ['eInvoice', 'Kivra'] });
    expect((await get(b.s.port, '/readyz')).status).toBe(200);
    await b.s.close();
    const all = `${b.err.join('')}${writes.join('')}${b.out.join('')}`;
    expect(all).not.toContain(`127.0.0.1:${port}`);
    expect(all).not.toContain('ECONNREFUSED');
  });
});

describe('stale gauge', () => {
  it('start() feeds the store staleness to the gauge (seconds), 0 again after a good reload', async () => {
    const m = memTelemetry();
    const t0 = T;
    let now = t0;
    let broken = false;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const env = W.mcpEnv();
    const good = W.state.f.text();
    const { s } = await W.boot(env, { telemetry: m.t, now: () => now, readFile: (p) => (p === env.MCP_TOKEN_LIST_FILE ? (broken ? '{' : good) : readFileSync(p, 'utf8')) });
    expect(await m.text()).toMatch(/^mcp_token_list_stale_seconds 0$/m);
    broken = true;
    now = t0 + 90_000;
    vi.advanceTimersByTime(60_000);
    const text = (await get(s.metricsPort, '/metrics')).text;
    expect(text).toMatch(/^mcp_token_list_stale_seconds 90$/m);
    broken = false;
    now = t0 + 100_000;
    vi.advanceTimersByTime(60_000);
    expect((await get(s.metricsPort, '/metrics')).text).toMatch(/^mcp_token_list_stale_seconds 0$/m);
  });
});

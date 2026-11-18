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
import type { CreateClientOptions, StralforsClient } from '../stralfors/index.ts';
import { hashToken } from '../auth/index.ts';
import * as telemetryModule from '../telemetry/index.ts';
import { TELEMETRY_FLUSH_MS } from './main.ts';
import { get, memTelemetry } from '../../test/helpers/telemetry.ts';
import { INIT, MCP_HEADERS } from '../../test/helpers/server.ts';
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
    await withOtlpHeaders({}, async () => {
      await W.boot(W.mcpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.test:4318' }));
    });
    expect(createTelemetry.mock.calls[0]![0].otlpEndpoint).toBe('http://collector.example.test:4318');
  });
});

const OTLP_HEADERS = ['OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS'];
// run fn with both OTLP header variables cleared from process.env (plus `set`), restoring them after, pass or fail
const withOtlpHeaders = async (set: Record<string, string>, fn: () => Promise<void>): Promise<void> => {
  const prev = OTLP_HEADERS.map((k) => process.env[k]);
  for (const k of OTLP_HEADERS) delete process.env[k];
  Object.assign(process.env, set);
  try {
    await fn();
  } finally {
    OTLP_HEADERS.forEach((k, i) => (prev[i] === undefined ? delete process.env[k] : (process.env[k] = prev[i])));
  }
};

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
    await withOtlpHeaders({ [h]: 'authorization=Bearer CANARY-SECRET' }, async () => {
      const e = await W.boot(W.mcpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.test:4318' })).then(() => undefined, (x: unknown) => x);
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toBe('OTEL_EXPORTER_OTLP_ENDPOINT must be https when OTLP headers are set');
      expect(createTelemetry).not.toHaveBeenCalled();
    });
  });

  it('http without headers is still accepted', async () => {
    createTelemetry.mockClear();
    await withOtlpHeaders({}, async () => {
      await W.boot(W.mcpEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.test:4318' }));
    });
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
      expect((e as Error).message).toBe('metrics listener failed (port in use or not permitted; see MCP_METRICS_PORT)');
      expect((e as Error).message).not.toMatch(/\d/); // no port, address or errno
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

  it('an HTTP bind failure refuses to start with fixed text that carries no port or address', async () => {
    const taken = new Server();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    try {
      const e = await W.boot(W.mcpEnv({ MCP_PORT: String(portOf(taken)), MCP_METRICS_PORT: '0' })).then(() => undefined, (x: unknown) => x);
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toBe('HTTP listener failed (port in use or not permitted; see MCP_PORT)');
      expect((e as Error).message).not.toMatch(/\d/);
      expect(JSON.stringify(e)).not.toContain(String(portOf(taken)));
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

  it('a malformed token list shuts the telemetry down, rejects with the ConfigError, and a second start works', async () => {
    const m = memTelemetry({ metricReader: undefined });
    const shutdown = vi.spyOn(m.t, 'shutdown');
    const env = W.mcpEnv();
    const e = await W.boot(env, { telemetry: m.t, readFile: (p) => (p === env.MCP_TOKEN_LIST_FILE ? '{' : readFileSync(p, 'utf8')) }).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    expect(shutdown).toHaveBeenCalledTimes(1);
    await W.boot(env, { telemetry: memTelemetry().t });
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
    const b = await W.boot(W.mcpEnv({ MCP_HEARTBEAT_S: '0' }), { clientFactory: (o) => clients[o.profileId as 'a' | 'b'], telemetry: m.t, onSignal: (fn) => void (signal = fn), ...extra });
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
    const { s } = await W.boot(W.mcpEnv({ MCP_HEARTBEAT_S: '0' }), { telemetry: m.t, timer, onSignal: (fn: () => void) => void (signal = fn) } as never);
    await withExitCode(async () => {
      signal();
      const p1 = s.close();
      expect(s.close()).toBe(p1);
      await expect(p1).rejects.toThrow('telemetry shutdown failed');
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
    });
    // every clearInterval is logged as 'store': the token store's timer plus one cert-reload timer per profile client (a and b)
    expect(order).toEqual(['store', 'store', 'store']);
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

describe('R-02 token list reload signalling', () => {
  const MIN = 60_000;
  const world = async () => {
    const m = memTelemetry();
    let now = T;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const env = W.mcpEnv({ MCP_HEARTBEAT_S: '0' });
    const good = W.state.f.text();
    let content = good;
    const b = await W.boot(env, { telemetry: m.t, now: () => now, readFile: (p) => (p === env.MCP_TOKEN_LIST_FILE ? content : readFileSync(p, 'utf8')) });
    const tick = () => {
      now += MIN;
      vi.advanceTimersByTime(MIN);
    };
    const list = () => JSON.parse(good) as { users: unknown[]; tokens: { userId: string; revoked?: boolean }[] };
    const reloads = async (outcome: string) => Number(new RegExp(`^mcp_token_list_reloads_total\\{outcome="${outcome}"\\} (\\d+)$`, 'm').exec(await m.text())?.[1] ?? 0);
    const status = (token: string) => fetch(`http://127.0.0.1:${b.s.port}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` }, body: INIT }).then((r) => r.status);
    return { ...b, tick, list, reloads, status, set: (c: string) => void (content = c), good };
  };

  it('counts failed per failing tick and ok per good tick, with one fixed warn per distinct cause and no id, hash or content in any line', async () => {
    const w = await world();
    const canary = `GHOST-${Math.random().toString(16).slice(2)}`;
    w.set(`{"x":"${canary}"`);
    w.tick(); w.tick();
    expect(await w.reloads('failed')).toBe(2);
    expect(w.logs().filter((l) => l.msg === 'reload.failed')).toHaveLength(1);
    const ghost = w.list();
    ghost.tokens[0]!.userId = canary; // a token that references a removed user
    w.set(JSON.stringify(ghost));
    w.tick();
    expect(await w.reloads('failed')).toBe(3);
    const warns = w.logs().filter((l) => l.msg === 'reload.failed');
    expect(warns).toHaveLength(2);
    for (const l of warns) expect(l).toMatchObject({ level: 40 });
    w.set(w.good);
    w.tick();
    expect(await w.reloads('ok')).toBe(1);
    expect(await w.reloads('failed')).toBe(3);
    const text = w.err.join('');
    for (const secret of [canary, hashToken(W.state.f.raw.tA), W.state.f.raw.tA, 'u1']) expect(text).not.toContain(secret);
    expect(await (await get(w.s.metricsPort, '/metrics')).text).not.toMatch(/mcp_token_list_reloads_total\{[^}]*(user|hash|kind)/);
  });

  it('a revoked token stays accepted while the reload fails and is rejected after the file is repaired; readiness is unaffected', async () => {
    const w = await world();
    const revoked = w.list();
    revoked.tokens[0]!.revoked = true;
    const broken = JSON.parse(JSON.stringify(revoked)) as typeof revoked;
    broken.tokens[2]!.userId = 'nobody';
    w.set(JSON.stringify(broken));
    w.tick(); w.tick();
    expect(await w.status(W.state.f.raw.tA)).toBe(200);
    expect(await w.reloads('failed')).toBe(2);
    w.set(JSON.stringify(revoked));
    w.tick();
    expect(await w.status(W.state.f.raw.tA)).toBe(401);
    expect((await get(w.s.port, '/readyz')).status).toBe(200);
    expect(await w.reloads('ok')).toBe(1);
  });
});

describe('R-06 certificate expiry and credential reload metrics', () => {
  const stubClient = (over: Record<string, unknown> = {}) => ({ close: async () => undefined, healthV1: async () => ({ status: 'UP' }), certExpiresAt: () => T + 86_400_000, ...over }) as unknown as StralforsClient;

  it('stralfors.client_cert.expiry_seconds is the earliest not-after across profiles minus now, with no profile label, read at scrape time', async () => {
    const m = memTelemetry();
    const at = { a: T + 5_000_000, b: T + 2_000_000 };
    const { s } = await W.boot(W.mcpEnv({ MCP_HEARTBEAT_S: '0' }), { telemetry: m.t, clientFactory: (o) => stubClient({ certExpiresAt: () => at[o.profileId as 'a' | 'b'] }) });
    expect((await get(s.metricsPort, '/metrics')).text).toMatch(/^stralfors_client_cert_expiry_seconds 2000$/m);
    at.b = T + 9_000_000; // hot swap of the earliest certificate
    expect((await get(s.metricsPort, '/metrics')).text).toMatch(/^stralfors_client_cert_expiry_seconds 5000$/m);
  });

  it('stralfors.credentials.reloads{outcome} counts what the clients report through onCredentialReload, nothing else', async () => {
    const m = memTelemetry();
    const opts: CreateClientOptions[] = [];
    const { s } = await W.boot(W.mcpEnv({ MCP_HEARTBEAT_S: '0' }), { telemetry: m.t, clientFactory: (o) => (opts.push(o), stubClient()) });
    expect(opts).toHaveLength(2);
    expect((await get(s.metricsPort, '/metrics')).text).not.toMatch(/^stralfors_credentials_reloads_total/m);
    opts[0]!.onCredentialReload!({ ok: true });
    opts[1]!.onCredentialReload!({ ok: false });
    opts[1]!.onCredentialReload!({ ok: false });
    const text = (await get(s.metricsPort, '/metrics')).text;
    expect(text).toMatch(/^stralfors_credentials_reloads_total\{outcome="ok"\} 1$/m);
    expect(text).toMatch(/^stralfors_credentials_reloads_total\{outcome="failed"\} 2$/m);
  });
});

describe('R-06 vendor heartbeat (setInterval, MCP_HEARTBEAT_S)', () => {
  const probes = () => {
    const calls = { a: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ status: 'UP' })), b: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ status: 'UP' })) };
    const clientFactory = (o: CreateClientOptions) => ({ close: async () => undefined, certExpiresAt: () => T + 86_400_000, healthV1: calls[o.profileId as 'a' | 'b'] }) as unknown as StralforsClient;
    return { calls, clientFactory };
  };
  const up = async (port: number) => /^stralfors_up\{[^}]*\} (\d+)$/m.exec((await get(port, '/metrics')).text);
  const boot = async (extra: Record<string, string> = {}, deps: Record<string, unknown> = {}) => {
    const m = memTelemetry();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const p = probes();
    const b = await W.boot(W.mcpEnv(extra), { telemetry: m.t, clientFactory: p.clientFactory, ...deps });
    await vi.advanceTimersByTimeAsync(0);
    return { ...p, ...b };
  };
  const calls = (p: { calls: Record<string, { mock: { calls: unknown[] } }> }) => [p.calls.a!.mock.calls.length, p.calls.b!.mock.calls.length];

  it.each([['-1'], ['3601'], ['1.5'], ['abc'], ['']])('MCP_HEARTBEAT_S=%j is refused with a ConfigError', async (v) => {
    const e = await W.boot(W.mcpEnv({ MCP_HEARTBEAT_S: v }), { clientFactory: probes().clientFactory }).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toBe('MCP_HEARTBEAT_S is invalid');
  });

  it.each([['0'], ['3600']])('MCP_HEARTBEAT_S=%s is accepted', async (v) => {
    await expect(W.boot(W.mcpEnv({ MCP_HEARTBEAT_S: v }), { clientFactory: probes().clientFactory })).resolves.toBeDefined();
  });

  it('default 60 s: every profile is probed once per minute with no argument, and stralfors.up{api="omni",env} is 1', async () => {
    const p = await boot();
    const [a0, b0] = calls(p);
    expect([a0, b0]).toEqual([0, 0]); // nothing is probed at start
    expect(await up(p.s.metricsPort)).toBeNull(); // and the series appears only after the first interval
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls(p)).toEqual([a0, b0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls(p)).toEqual([a0! + 1, b0! + 1]);
    for (const c of [p.calls.a, p.calls.b]) for (const args of c.mock.calls) expect(args).toEqual([]); // no payload
    const text = (await get(p.s.metricsPort, '/metrics')).text;
    expect(text).toMatch(/^stralfors_up\{api="omni",env="test"\} 1$/m);
  });

  it('MCP_HEARTBEAT_S sets the interval', async () => {
    const p = await boot({ MCP_HEARTBEAT_S: '5' });
    const [a0] = calls(p);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls(p)[0]).toBe(a0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls(p)[0]).toBe(a0! + 1);
  });

  it('MCP_HEARTBEAT_S=0 disables it: no probe, no up series', async () => {
    const p = await boot({ MCP_HEARTBEAT_S: '0' });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(calls(p)).toEqual([0, 0]);
    expect((await get(p.s.metricsPort, '/metrics')).text).not.toMatch(/^stralfors_up/m); // any label shape, any value
  });

  it('MCP_HEARTBEAT_S=0: close() still resolves and closes every client (no timer to stop)', async () => {
    const closed: string[] = [];
    const { s } = await W.boot(W.mcpEnv({ MCP_HEARTBEAT_S: '0' }), { telemetry: memTelemetry().t, clientFactory: (o) => ({ close: async () => void closed.push(o.profileId), certExpiresAt: () => T, healthV1: async () => ({ status: 'UP' }) }) as unknown as StralforsClient });
    await expect(s.close()).resolves.toBeUndefined();
    expect(closed.sort()).toEqual(['a', 'b']);
  });

  it('a profile that is not UP (rejected or DOWN) makes the gauge 0 and never touches /readyz; recovery brings it back to 1', async () => {
    const p = await boot();
    p.calls.b.mockRejectedValue(new Error('down'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await up(p.s.metricsPort))![1]).toBe('0');
    expect((await get(p.s.port, '/readyz')).status).toBe(200);
    p.calls.b.mockResolvedValue({ status: 'DOWN' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await up(p.s.metricsPort))![1]).toBe('0');
    expect((await get(p.s.port, '/readyz')).status).toBe(200);
    p.calls.b.mockResolvedValue({ status: 'UP' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await up(p.s.metricsPort))![1]).toBe('1');
  });

  it('a failing probe warns once per change of state, not per probe, and no response body or error text reaches any line', async () => {
    const p = await boot();
    const warns = () => p.logs().filter((l) => l.level === 40).length;
    const w0 = warns();
    const body = `BODY-CANARY-${Math.random().toString(16).slice(2)}`;
    p.calls.b.mockResolvedValue({ status: 'DOWN', name: body, detailChecks: [{ status: body }] });
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(warns()).toBe(w0 + 1);
    p.calls.b.mockRejectedValue(new Error(body));
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(warns()).toBe(w0 + 1); // DOWN then a rejection is still DOWN: no second warning
    expect(`${p.err.join('')}${p.out.join('')}`).not.toContain(body);
  });

  it('the state-change lines are upstream.down at warn and upstream.up (recovery) at info, with no fields', async () => {
    const p = await boot();
    const lines = () => p.logs().filter((l) => l.msg === 'upstream.down' || l.msg === 'upstream.up').map((l) => [l.msg, l.level]);
    expect(lines()).toEqual([]); // first probe is UP after the first interval; the start state is silent
    p.calls.b.mockResolvedValue({ status: 'DOWN' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines()).toEqual([['upstream.down', 40]]);
    p.calls.b.mockResolvedValue({ status: 'UP' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines()).toEqual([['upstream.down', 40], ['upstream.up', 30]]);
    // the full field set: the message plus standard logger metadata (and the trace ids the mixin adds), nothing probe-specific
    for (const l of p.logs().filter((x) => x.msg === 'upstream.down' || x.msg === 'upstream.up')) {
      expect(Object.keys(l).filter((k) => k !== 'trace_id' && k !== 'span_id').sort()).toEqual(['hostname', 'level', 'msg', 'name', 'pid', 'time']);
    }
  });

  it('a slow round never overlaps the next: no second probe while one is in flight, no stale result, one recovery line', async () => {
    const p = await boot();
    let release!: (v: unknown) => void;
    p.calls.b.mockImplementationOnce(() => new Promise((r) => (release = r))); // round 1 hangs on b
    const n = p.calls.b.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000 * 3); // three ticks while round 1 is in flight
    expect(p.calls.b.mock.calls.length).toBe(n + 1); // ticks 2 and 3 were skipped
    release({ status: 'DOWN' });
    await vi.advanceTimersByTimeAsync(0);
    expect((await up(p.s.metricsPort))![1]).toBe('0');
    await vi.advanceTimersByTimeAsync(60_000); // the next round starts again and recovers
    expect(p.calls.b.mock.calls.length).toBe(n + 2);
    expect(p.logs().filter((l) => l.msg === 'upstream.up')).toHaveLength(1);
  });

  it('the heartbeat interval is unref-ed (never holds the process) and cleared on shutdown', async () => {
    const handles: { ms: unknown; unref: ReturnType<typeof vi.fn> }[] = [];
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((_fn: unknown, ms: unknown) => {
      const h = { ms, unref: vi.fn() };
      handles.push(h);
      return h;
    }) as never);
    const clear = vi.spyOn(globalThis, 'clearInterval');
    try {
      const { s } = await W.boot(W.mcpEnv({ MCP_HEARTBEAT_S: '7' }), { telemetry: memTelemetry().t, clientFactory: probes().clientFactory });
      const beat = handles.find((h) => h.ms === 7000)!;
      expect(beat.unref).toHaveBeenCalledTimes(1);
      expect(clear).not.toHaveBeenCalledWith(beat);
      await s.close();
      expect(clear).toHaveBeenCalledWith(beat);
    } finally {
      spy.mockRestore();
      clear.mockRestore();
    }
  });

  it('a probe that resolves DOWN after close() began neither logs nor publishes', async () => {
    const held: (() => void)[] = []; // shutdown stays in the readiness delay until released; other timers are real
    const timer = ((fn: () => void, ms: number) => (ms === 5000 ? (held.push(fn), { unref: () => undefined }) : setTimeout(fn, ms))) as unknown as typeof setTimeout;
    const p = await boot({ MCP_READY_DELAY_MS: '5000' }, { timer });
    let finish!: (v: unknown) => void;
    p.calls.a.mockImplementationOnce(() => new Promise((r) => void (finish = r)));
    await vi.advanceTimersByTimeAsync(60_000); // a round starts and hangs on profile a
    const closing = p.s.close();
    try {
      finish({ status: 'DOWN' });
      await vi.advanceTimersByTimeAsync(0);
      expect(await up(p.s.metricsPort)).toBeNull(); // the scrape succeeded and carries no stralfors_up sample
      expect(p.logs().some((l) => l.msg === 'upstream.down' || l.msg === 'upstream.up')).toBe(false);
    } finally {
      held.splice(0).forEach((f) => f());
      await closing;
    }
  });

  it('close() stops the timer: no probe afterwards and two fewer timers (token store and heartbeat)', async () => {
    const p = await boot();
    const before = vi.getTimerCount();
    const n = calls(p);
    await p.s.close();
    expect(vi.getTimerCount()).toBe(before - 2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls(p)).toEqual(n);
  });
});

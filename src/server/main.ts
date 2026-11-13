import { readFileSync, realpathSync } from 'node:fs';
import { isIPv6 } from 'node:net';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createAudit, fromBlocked, type Audit } from '../audit/index.ts';
import { createTokenStore, type Env } from '../auth/index.ts';
import { ConfigError } from '../stralfors/errors.ts';
import { createClient, createLogger, loadConfig, type CreateClientOptions, type StralforsClient } from '../stralfors/index.ts';
import { createListChannels } from './channels.ts';
import { serverInfo } from '../server-info.ts';
import { activeIds, createTelemetry, logMixin, upstreamInstrument, type Telemetry } from '../telemetry/index.ts';
import { currentPrincipal } from './context.ts';
import { text } from './guards.ts';
import { createHttpServer } from './http.ts';
import { buildMcp } from './mcp.ts';
import { createRulesCache } from './rules-cache.ts';
import { createGetExampleInvoice, createGetRules } from './rules-tools.ts';
import { DEFAULT_MAX_OUTPUT_BYTES } from './tools.ts';
import { createRateLimiter } from './rate-limit.ts';
import { createValidateInvoice } from './validate-tool.ts';
import { createWhoami } from './whoami.ts';

export interface StartDeps {
  readFile?: (path: string) => string;
  stderr?: { write(s: string): void };
  audit?: Audit;
  now?: () => number;
  /** limiter clock; must not step backwards (unlike wall-clock now, which token expiry needs) */
  monotonic?: () => number;
  onSignal?: (fn: () => void) => void;
  clientFactory?: (o: CreateClientOptions) => StralforsClient;
  /** prebuilt telemetry (in-memory seams in tests); start() still owns its shutdown */
  telemetry?: Telemetry;
  /** test seam for the telemetry flush bound */
  timer?: typeof setTimeout;
}
export interface Started { port: number; metricsPort: number; close(): Promise<void> }
export const TELEMETRY_FLUSH_MS = 5_000;

const HOSTNAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
// Allowlist entries: a hostname, or an IPv6 literal bare or bracketed (stored bracketed, as WHATWG URL reports it). No scheme, no port.
const entry = (h: string): string | undefined => {
  const m = /^\[(.*)\]$/.exec(h);
  const inner = m ? m[1]! : h;
  if (isIPv6(inner)) return inner.includes('%') ? undefined : new URL(`http://[${inner}]`).hostname; // canonical form, as the Host check sees it; zone ids are not valid in a Host header
  return m || !HOSTNAME.test(h) ? undefined : h.toLowerCase();
};
const list = (name: string, v: string): string[] => {
  const out = v.split(',').map((s) => s.trim()).filter(Boolean).map(entry);
  if (out.length === 0 || out.includes(undefined)) throw new ConfigError(`${name} is invalid`);
  return [...new Set(out as string[])];
};
const int = (name: string, v: string | undefined, def: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
  if (v === undefined) return def;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < min || n > max) throw new ConfigError(`${name} is invalid`);
  return n;
};

const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);
const level = (v: string | undefined): string => {
  if (v === undefined) return 'info';
  if (!LEVELS.has(v)) throw new ConfigError('MCP_LOG_LEVEL is invalid');
  return v;
};

const RATIO = /^(0|1|0?\.\d+|1\.0+)$/;
const ratio = (v: string | undefined): number => {
  if (v === undefined) return 0.1;
  if (!RATIO.test(v) || Number(v) > 1) throw new ConfigError('MCP_TRACE_SAMPLE_RATIO is invalid');
  return Number(v);
};
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const endpoint = (v: string | undefined, env: Record<string, string | undefined>): string | undefined => {
  if (!v) return undefined;
  try {
    const u = new URL(v);
    if (/^https?:$/.test(u.protocol) && !/[?#]/.test(v)) { // the exporter path is appended to the raw string: no query or fragment
      // the exporter reads these headers from process.env whatever the url, so check it and the supplied env: never send them in cleartext off the host
      if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname) && (env.OTEL_EXPORTER_OTLP_HEADERS || env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || process.env.OTEL_EXPORTER_OTLP_HEADERS || process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS)) throw new ConfigError('OTEL_EXPORTER_OTLP_ENDPOINT must be https when OTLP headers are set');
      return v;
    }
  } catch (e) {
    if (e instanceof ConfigError) throw e;
  }
  throw new ConfigError('OTEL_EXPORTER_OTLP_ENDPOINT is invalid');
};

export async function start(env: Record<string, string | undefined>, deps: StartDeps = {}): Promise<Started> {
  const file = env.MCP_TOKEN_LIST_FILE;
  if (!file) throw new ConfigError('missing MCP_TOKEN_LIST_FILE');
  if (!env.MCP_HOSTNAMES) throw new ConfigError('missing MCP_HOSTNAMES');
  const hosts = list('MCP_HOSTNAMES', env.MCP_HOSTNAMES);
  const origins = env.MCP_ORIGINS === undefined ? hosts : list('MCP_ORIGINS', env.MCP_ORIGINS);
  const port = int('MCP_PORT', env.MCP_PORT, 3000, 0, 65535); // ponytail: 0 is accepted outside tests too (random port); harmless
  const maxBodyBytes = int('MCP_MAX_BODY_BYTES', env.MCP_MAX_BODY_BYTES, 1_048_576, 1);
  const drainMs = int('MCP_DRAIN_MS', env.MCP_DRAIN_MS, 10_000, 0);
  if (env.STRALFORS_ENV !== 'test' && env.STRALFORS_ENV !== 'prod') throw new ConfigError('STRALFORS_ENV is invalid');
  if (env.STRALFORS_ALLOW_WRITE !== undefined && env.STRALFORS_ALLOW_WRITE !== 'true' && env.STRALFORS_ALLOW_WRITE !== 'false') throw new ConfigError('STRALFORS_ALLOW_WRITE is invalid');
  if (env.STRALFORS_ENV === 'prod' && env.STRALFORS_ALLOW_WRITE === 'true') throw new ConfigError('write is never allowed in prod (STRALFORS_ALLOW_WRITE)');
  const metricsPort = int('MCP_METRICS_PORT', env.MCP_METRICS_PORT, 9464, 0, 65535);
  const metricsHost = env.MCP_METRICS_HOST ?? '0.0.0.0';
  if (!metricsHost.trim()) throw new ConfigError('MCP_METRICS_HOST is invalid');
  const sampleRatio = ratio(env.MCP_TRACE_SAMPLE_RATIO);
  const otlpEndpoint = endpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT, env);
  const logLevel = level(env.MCP_LOG_LEVEL);
  const perMinute = int('MCP_RATE_PER_MINUTE', env.MCP_RATE_PER_MINUTE, 120, 1);
  const burst = int('MCP_RATE_BURST', env.MCP_RATE_BURST, 30, 1);
  const maxOutputBytes = int('MCP_TOOL_OUTPUT_MAX_BYTES', env.MCP_TOOL_OUTPUT_MAX_BYTES, DEFAULT_MAX_OUTPUT_BYTES, 1);
  const rulesCacheS = int('MCP_RULES_CACHE_S', env.MCP_RULES_CACHE_S, 3600, 0, 86_400);
  const staleAfterMs = int('MCP_TOKEN_STALE_MS', env.MCP_TOKEN_STALE_MS, 900_000, 1);

  const now = deps.now ?? Date.now;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const stderr = deps.stderr ?? process.stderr;
  const config = loadConfig(env, { readFileSync: (p) => readFile(p) }); // before the store: a config error leaves nothing to close
  if (Object.keys(config.profiles).length === 0) throw new ConfigError('STRALFORS_PROFILES is empty');
  const deploy: Env = config.env;
  const allowWrite = config.allowWrite;
  const store = createTokenStore({ read: () => readFile(file), now, staleAfterMs, onStale: () => void stderr.write('token_list.stale\n') });
  const telemetry = deps.telemetry ?? createTelemetry({ serviceVersion: serverInfo.version, env: deploy, sampleRatio, otlpEndpoint });
  telemetry.instruments.observeStale(store.staleMs);
  const audit = deps.audit ?? createAudit({ destination: process.stdout, now, otelTraceId: () => activeIds()?.trace_id });
  const clients = new Map<string, StralforsClient>();
  const closeClients = () => Promise.allSettled([...clients.values()].map((c) => c.close()));
  const logger = createLogger({ level: logLevel, destination: stderr, mixin: logMixin });
  const make = deps.clientFactory ?? createClient;
  const timer = deps.timer ?? setTimeout;
  const shutdownTelemetry = async () => {
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([telemetry.shutdown(), new Promise<never>((_, rej) => void (t = timer(() => rej(new Error('timeout')), TELEMETRY_FLUSH_MS)).unref?.())]);
    } finally {
      clearTimeout(t);
    }
  };
  const metrics: Server = createServer((req, res) => {
    let path: string | undefined;
    try {
      path = new URL(req.url ?? '/', 'http://x').pathname;
    } catch { /* malformed target, e.g. '//' */ }
    if (req.method === 'GET' && path === '/metrics') return telemetry.metricsHandler(req, res);
    const r = path === undefined ? text(400, 'bad request') : text(404, 'not found');
    res.writeHead(r.status, r.headers).end(r.body);
  });
  const closeMetrics = () => new Promise<void>((r) => {
    if (!metrics.listening) return r();
    metrics.close(() => r());
    metrics.closeAllConnections();
  });
  let srv: ReturnType<typeof createHttpServer>;
  let listening: { port: number };
  let metricsListening: number;
  try {
    for (const id of Object.keys(config.profiles)) {
      clients.set(id, make({ config, profileId: id, logger, now, instrument: upstreamInstrument(telemetry), onBlocked: (e) => void audit.record({ ...fromBlocked(e), principal: currentPrincipal(), env: deploy }) }));
    }
    const profiles = Object.values(config.profiles).map((p) => ({ id: p.id, country: p.country }));
    const cache = createRulesCache({ ttlMs: rulesCacheS * 1000, now });
    const tools = [createWhoami(profiles), createListChannels({ clients, config }), createGetRules({ clients, cache }), createGetExampleInvoice({ clients }), createValidateInvoice({ clients, config, cache })];
    const limiter = createRateLimiter({ perMinute, burst, now: deps.monotonic ?? (() => performance.now()) });
    metricsListening = await new Promise<number>((resolve, reject) => {
      metrics.once('error', () => reject(new ConfigError('metrics listener failed (port in use or not permitted; see MCP_METRICS_PORT)'))); // the OS error carries the address: not forwarded
      metrics.listen(metricsPort, metricsHost, () => resolve((metrics.address() as { port: number }).port));
    });
    srv = createHttpServer({ store, audit, telemetry, monotonic: deps.monotonic, env: deploy, hosts, origins, maxBodyBytes, drainMs, now, limiter, factory: buildMcp({ env: deploy, allowWrite, prodValidateEnabled: config.prodValidateEnabled, audit, tools, now, telemetry, maxOutputBytes }) });
    listening = await srv.listen(port, env.MCP_LISTEN_HOST ?? '0.0.0.0').catch(() => { // the OS error carries the address: not forwarded
      throw new ConfigError('HTTP listener failed (port in use or not permitted; see MCP_PORT)');
    });
    logger.debug({}, 'listening'); // the one line at debug: proves the level took effect; ports are not logged
  } catch (e) {
    await closeClients();
    await closeMetrics();
    await shutdownTelemetry().catch(() => undefined);
    store.close();
    throw e;
  }
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= (async () => {
    let r: PromiseSettledResult<void>[];
    let first: string | undefined;
    try {
      await srv.close();
    } finally {
      r = await closeClients();
      if (r.some((x) => x.status === 'rejected')) first = 'client close failed';
      await closeMetrics().catch(() => undefined);
      await shutdownTelemetry().catch(() => void (first ??= 'telemetry shutdown failed'));
      store.close();
    }
    if (first) throw new Error(first);
  })());
  const onSignal = deps.onSignal ?? ((fn) => {
    process.once('SIGTERM', fn);
    process.once('SIGINT', fn);
  });
  onSignal(() => void close().then(() => void (process.exitCode = 0), () => void (process.exitCode = 1)));
  return { port: listening.port, metricsPort: metricsListening, close };
}

// import.meta.main needs Node 24.2; engines allows 24.0
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  start(process.env).catch((e: unknown) => {
    process.stderr.write(`refusing to start: ${e instanceof ConfigError ? e.message : 'unexpected error'}\n`);
    process.exit(1);
  });
}

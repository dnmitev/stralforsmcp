import { readFileSync, realpathSync } from 'node:fs';
import { isIPv6 } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createAudit, fromBlocked, type Audit } from '../audit/index.ts';
import { createTokenStore, type Env } from '../auth/index.ts';
import { ConfigError } from '../stralfors/errors.ts';
import { createClient, createLogger, loadConfig, type CreateClientOptions, type StralforsClient } from '../stralfors/index.ts';
import { createListChannels } from './channels.ts';
import { currentPrincipal } from './context.ts';
import { createHttpServer } from './http.ts';
import { buildMcp } from './mcp.ts';
import { createRateLimiter } from './rate-limit.ts';
import { createWhoami } from './whoami.ts';

export interface StartDeps {
  readFile?: (path: string) => string;
  stderr?: { write(s: string): void };
  audit?: Audit;
  now?: () => number;
  onSignal?: (fn: () => void) => void;
  clientFactory?: (o: CreateClientOptions) => StralforsClient;
}
export interface Started { port: number; close(): Promise<void> }

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
  const perMinute = int('MCP_RATE_PER_MINUTE', env.MCP_RATE_PER_MINUTE, 120, 1);
  const burst = int('MCP_RATE_BURST', env.MCP_RATE_BURST, 30, 1);
  const staleAfterMs = int('MCP_TOKEN_STALE_MS', env.MCP_TOKEN_STALE_MS, 900_000, 1);

  const now = deps.now ?? Date.now;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const stderr = deps.stderr ?? process.stderr;
  const config = loadConfig(env, { readFileSync: (p) => readFile(p) }); // before the store: a config error leaves nothing to close
  if (Object.keys(config.profiles).length === 0) throw new ConfigError('STRALFORS_PROFILES is empty');
  const deploy: Env = config.env;
  const allowWrite = config.allowWrite;
  const store = createTokenStore({ read: () => readFile(file), now, staleAfterMs, onStale: () => void stderr.write('token_list.stale\n') });
  const audit = deps.audit ?? createAudit({ destination: process.stdout, now });
  const clients = new Map<string, StralforsClient>();
  const closeClients = () => Promise.allSettled([...clients.values()].map((c) => c.close()));
  const logger = createLogger({ level: 'info', destination: stderr });
  const make = deps.clientFactory ?? createClient;
  let srv: ReturnType<typeof createHttpServer>;
  let listening: { port: number };
  try {
    for (const id of Object.keys(config.profiles)) {
      clients.set(id, make({ config, profileId: id, logger, now, onBlocked: (e) => void audit.record({ ...fromBlocked(e), principal: currentPrincipal(), env: deploy }) }));
    }
    const profiles = Object.values(config.profiles).map((p) => ({ id: p.id, country: p.country }));
    const tools = [createWhoami(profiles), createListChannels({ clients, config })];
    const limiter = createRateLimiter({ perMinute, burst, now });
    srv = createHttpServer({ store, audit, env: deploy, hosts, origins, maxBodyBytes, drainMs, now, limiter, factory: buildMcp({ env: deploy, allowWrite, audit, tools, now }) });
    listening = await srv.listen(port, env.MCP_LISTEN_HOST ?? '0.0.0.0');
  } catch (e) {
    await closeClients();
    store.close();
    throw e;
  }
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= (async () => {
    let r: PromiseSettledResult<void>[];
    try {
      await srv.close();
    } finally {
      r = await closeClients();
      store.close();
    }
    if (r.some((x) => x.status === 'rejected')) throw new Error('client close failed');
  })());
  const onSignal = deps.onSignal ?? ((fn) => {
    process.once('SIGTERM', fn);
    process.once('SIGINT', fn);
  });
  onSignal(() => void close().then(() => void (process.exitCode = 0), () => void (process.exitCode = 1)));
  return { port: listening.port, close };
}

// import.meta.main needs Node 24.2; engines allows 24.0
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  start(process.env).catch((e: unknown) => {
    process.stderr.write(`refusing to start: ${e instanceof ConfigError ? e.message : 'unexpected error'}\n`);
    process.exit(1);
  });
}

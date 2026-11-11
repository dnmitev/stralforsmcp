import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createAudit, type Audit } from '../audit/index.ts';
import { createTokenStore, type Env } from '../auth/index.ts';
import { ConfigError } from '../stralfors/errors.ts';
import { createHttpServer } from './http.ts';
import { buildMcp } from './mcp.ts';
import { whoami } from './whoami.ts';

export interface StartDeps {
  readFile?: (path: string) => string;
  stderr?: { write(s: string): void };
  audit?: Audit;
  now?: () => number;
  onSignal?: (fn: () => void) => void;
}
export interface Started { port: number; close(): Promise<void> }

const HOSTNAME = /^[A-Za-z0-9.:[\]_-]+$/;
const list = (name: string, v: string): string[] => {
  const out = [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))];
  // hostname only: no scheme, no port (a bare IPv6 literal contains ':' and is accepted only in brackets-free form by the SDK guards)
  if (out.length === 0 || out.some((h) => !HOSTNAME.test(h) || (h.includes(':') && !h.includes('::')))) throw new ConfigError(`${name} is invalid`);
  return out;
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
  const deploy: Env = env.STRALFORS_ENV;
  const allowWrite = env.STRALFORS_ALLOW_WRITE === 'true';
  if (env.STRALFORS_ALLOW_WRITE !== undefined && env.STRALFORS_ALLOW_WRITE !== 'true' && env.STRALFORS_ALLOW_WRITE !== 'false') throw new ConfigError('STRALFORS_ALLOW_WRITE is invalid');
  if (deploy === 'prod' && allowWrite) throw new ConfigError('write is never allowed in prod (STRALFORS_ALLOW_WRITE)');

  const now = deps.now ?? Date.now;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const store = createTokenStore({ read: () => readFile(file), now });
  const audit = deps.audit ?? createAudit({ destination: process.stdout, now });
  const srv = createHttpServer({ store, audit, env: deploy, hosts, origins, maxBodyBytes, drainMs, now, factory: buildMcp({ env: deploy, allowWrite, audit, tools: [whoami], now }) });
  const listening = await srv.listen(port, env.MCP_LISTEN_HOST ?? '0.0.0.0').catch((e: unknown) => {
    store.close();
    throw e;
  });
  const close = async () => {
    await srv.close();
    store.close();
  };
  const onSignal = deps.onSignal ?? ((fn) => {
    process.once('SIGTERM', fn);
    process.once('SIGINT', fn);
  });
  onSignal(() => void close().then(() => void (process.exitCode = 0)));
  return { port: listening.port, close };
}

// import.meta.main needs Node 24.2; engines allows 24.0
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start(process.env).catch((e: unknown) => {
    process.stderr.write(`refusing to start: ${e instanceof ConfigError ? e.message : 'unexpected error'}\n`);
    process.exit(1);
  });
}

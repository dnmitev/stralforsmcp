// start() world for the 02-04 tests: two-profile fake Stralfors API, a temp token-list file, in-memory telemetry, captured stderr and audit (stdout).
// Call useStartWorld() once at the top of a test file: it registers the hooks.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { createClient, type CreateClientOptions, type StralforsClient } from '../../src/stralfors/index.ts';
import { start, type Started } from '../../src/server/main.ts';
import { json } from './api.ts';
import { startChannelsApi, twoProfiles, type TwoProfiles } from './boot.ts';
import { generatePki, type Pki } from './mtls.ts';
import { connect, type Era } from './server.ts';
import { fixture, T, type Fixture } from './token-list.ts';

type Deps = NonNullable<Parameters<typeof start>[1]>;
export const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number };
    s.close(() => resolve(port));
  });
});

export function useStartWorld() {
  let pki: Pki;
  let dir: string;
  let api: Awaited<ReturnType<typeof startChannelsApi>>;
  const state = { f: undefined as unknown as Fixture, tp: undefined as unknown as TwoProfiles };
  const started: Started[] = [];

  beforeAll(async () => {
    pki = generatePki();
    dir = mkdtempSync(join(tmpdir(), 'smcp-tel-'));
    api = await startChannelsApi(pki, { body: ['eInvoice', 'Kivra'] });
  });
  afterAll(async () => {
    await api.fake.close();
    pki.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    api.reply.current = (_q, res) => json(res, 200, ['eInvoice', 'Kivra']);
    await Promise.all(started.splice(0).map((s) => s.close().catch(() => undefined)));
  });

  const mcpEnv = (extra: Record<string, string | undefined> = {}) => {
    state.f = fixture();
    const tokenFile = join(dir, `tokens-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(tokenFile, state.f.text());
    state.tp = twoProfiles(pki);
    return { MCP_TOKEN_LIST_FILE: tokenFile, MCP_HOSTNAMES: '127.0.0.1', MCP_PORT: '0', MCP_LISTEN_HOST: '127.0.0.1', MCP_METRICS_PORT: '0', MCP_METRICS_HOST: '127.0.0.1', ...state.tp.env, ...extra };
  };
  const real = (o: CreateClientOptions): StralforsClient => createClient({ ...o, ca: pki.ca, baseUrl: api.fake.url });
  const stub = (id: string, order: string[] = []) => ({ close: vi.fn(async () => void order.push(`close ${id}`)), channels: async () => ['x'] }) as unknown as StralforsClient;
  /** start() with stderr and stdout (the default audit destination) captured; stdout is swallowed. */
  const boot = async (env: Record<string, string | undefined>, deps: Deps = {}) => {
    const err: string[] = [];
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => (out.push(String(c)), true)) as typeof process.stdout.write);
    const s = await start(env, { stderr: { write: (x) => void err.push(x) }, now: () => T, onSignal: () => undefined, clientFactory: real, ...deps });
    started.push(s);
    const audit = () => out.join('').split('\n').filter((l) => l.includes('"log.type":"audit"')).map((l) => JSON.parse(l) as Record<string, unknown>);
    const logs = () => err.join('').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { s, err, out, audit, logs };
  };
  const bearer = (port: number, token: string): typeof fetch => (url, init) =>
    fetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${token}` } });
  const call = async (era: Era, port: number, token: string, name: string, args: Record<string, unknown>) => (await connect(era, bearer(port, token))).callTool({ name, arguments: args });
  return { mcpEnv, boot, stub, real, call, bearer, state, started, get api() { return api; }, get pki() { return pki; } };
}

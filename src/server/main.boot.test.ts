/*
 * R24 bootstrap: Stralfors config, one client per profile, close order, env, whoami profiles, staleness wiring.
 * API under test (src/server/main.ts): start(env, { clientFactory, readFile, stderr, audit, now, onSignal }) => { port, close }.
 * [fake-api] = in-process mTLS fake behind deps.clientFactory.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, type CreateClientOptions, type StralforsClient } from '../stralfors/index.ts';
import { ConfigError } from '../stralfors/errors.ts';
import { whoamiOutput } from './whoami.ts';
import { start, type Started } from './main.ts';
import { json } from '../../test/helpers/api.ts';
import { startChannelsApi, twoProfiles, type TwoProfiles } from '../../test/helpers/boot.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { ERAS, MCP_HEADERS, INIT, connect, send, sink, type Era } from '../../test/helpers/server.ts';
import { fixture, T, type Fixture } from '../../test/helpers/token-list.ts';

let pki: Pki;
let dir: string;
let api: Awaited<ReturnType<typeof startChannelsApi>>;
let tp: TwoProfiles;
let f: Fixture;
let tokenFile: string;
const started: Started[] = [];

beforeAll(async () => {
  pki = generatePki();
  dir = mkdtempSync(join(tmpdir(), 'smcp-boot-'));
  api = await startChannelsApi(pki, { body: ['eInvoice', 'Kivra'] });
});
afterAll(async () => {
  await api.fake.close();
  pki.cleanup();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  api.reply.current = (_q, res) => json(res, 200, ['eInvoice', 'Kivra']);
  await Promise.all(started.splice(0).map((s) => s.close().catch(() => undefined)));
});

const mcpEnv = (extra: Record<string, string | undefined> = {}) => {
  f = fixture();
  tokenFile = join(dir, `tokens-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(tokenFile, f.text());
  tp = twoProfiles(pki);
  return { MCP_TOKEN_LIST_FILE: tokenFile, MCP_HOSTNAMES: '127.0.0.1', MCP_PORT: '0', MCP_METRICS_PORT: '0', MCP_METRICS_HOST: '127.0.0.1', MCP_LISTEN_HOST: '127.0.0.1', ...tp.env, ...extra };
};
type Deps = NonNullable<Parameters<typeof start>[1]>;
const real = (o: CreateClientOptions): StralforsClient => createClient({ ...o, ca: pki.ca, baseUrl: api.fake.url });
const stub = (id: string, order: string[] = [], over: Partial<{ close: () => Promise<void>; channels: (a?: string) => Promise<string[]> }> = {}) =>
  ({ close: vi.fn(async () => void order.push(`close ${id}`)), channels: async () => ['x'], ...over }) as unknown as StralforsClient;
const boot = async (env: Record<string, string | undefined>, deps: Deps = {}) => {
  const err: string[] = [];
  const out = sink();
  const s = await start(env, { stderr: { write: (x) => void err.push(x) }, audit: out.audit, now: () => T, onSignal: () => undefined, clientFactory: real, ...deps });
  started.push(s);
  return { s, err, out };
};
const bearer = (port: number, token: string): typeof fetch => (url, init) =>
  fetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${token}` } });
const call = async (era: Era, port: number, token: string, name: string, args: Record<string, unknown>) => (await connect(era, bearer(port, token))).callTool({ name, arguments: args });
const texts = (r: unknown) => JSON.stringify(r);

describe('one client per profile for the process lifetime', () => {
  it('created in config order before listen, never per request; the token is fetched once', async () => {
    const env = mcpEnv();
    const factory = vi.fn(real);
    const listen = vi.spyOn(Server.prototype, 'listen');
    const { s } = await boot(env, { clientFactory: factory });
    expect(factory.mock.calls.map(([o]) => o.profileId)).toEqual(['a', 'b']);
    expect(Math.max(...factory.mock.invocationCallOrder)).toBeLessThan(listen.mock.invocationCallOrder[0]!);
    const before = api.channelRequests().length;
    const tokensBefore = api.fake.tokenRequests.length;
    for (let i = 0; i < 3; i++) await call('modern', s.port, f.raw.tA, 'list_channels', { profile: 'a' });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(api.channelRequests().length - before).toBe(3);
    expect(api.fake.tokenRequests.length - tokensBefore).toBe(1);
  });

  it('every client gets the config, a logger and an onBlocked hook', async () => {
    const env = mcpEnv();
    const factory = vi.fn(real);
    await boot(env, { clientFactory: factory });
    expect(factory).toHaveBeenCalledTimes(2);
    for (const [o] of factory.mock.calls) {
      expect(o.logger).toBeDefined();
      expect(o.onBlocked).toBeTypeOf('function');
      expect(o.config.env).toBe('test');
    }
  });

  it('the onBlocked hook audits blocked with the anonymous principal outside a call', async () => {
    const env = mcpEnv();
    let hook: CreateClientOptions['onBlocked'];
    const { out } = await boot(env, { clientFactory: (o) => ((hook ??= o.onBlocked), real(o)) });
    hook!({ profile: 'a', method: 'POST', pathTemplate: '/rest/outputmanagement/apiomni/v2/invoices/true' });
    expect(out.lines().at(-1)).toMatchObject({ outcome: 'blocked', reason: 'write_guard', userId: 'anonymous', env: 'test' });
  });
});

describe.each(ERAS)('end to end (%s era)', (era) => {
  it('list_channels with an agreement label reaches the fake with the id; no secret or id in any sink', async () => {
    const env = mcpEnv();
    const { s, err, out } = await boot(env);
    const r = await call(era, s.port, f.raw.tA, 'list_channels', { profile: 'b', agreement: 'letters' });
    expect(r.structuredContent).toEqual({ profile: 'b', channels: ['eInvoice', 'Kivra'] });
    expect(new URL(api.channelRequests().at(-1)!.url, 'https://x').searchParams.get('actionId')).toBe(tp.uuid.b);
    const sinks = `${texts(r)}${out.text()}${err.join('')}${inspect(s)}${JSON.stringify(s)}`;
    for (const c of [tp.uuid.a, tp.uuid.aNoLabel, tp.uuid.b, `127.0.0.1:${api.fake.port}`, ...tp.secrets, 'PRIVATE KEY', f.raw.tA]) expect(sinks).not.toContain(c);
    expect(out.lines().map((l) => [l.tool, l.outcome])).toContainEqual(['list_channels', 'allowed']);
  });

  it('bad input: exact fixed texts, no upstream call, one bad_input audit line each', async () => {
    const env = mcpEnv();
    const { s, out } = await boot(env);
    const before = api.fake.requests.length;
    const cases: [Record<string, unknown>, string][] = [[{}, 'profile is required'], [{ profile: 'nope' }, 'unknown profile'], [{ profile: 'a', agreement: 'nope' }, 'unknown agreement']];
    for (const [args, text] of cases) {
      const r = await call(era, s.port, f.raw.tA, 'list_channels', args);
      expect(r).toMatchObject({ isError: true, content: [{ type: 'text', text }] });
    }
    expect(api.fake.requests.length).toBe(before);
    expect(out.lines().filter((l) => l.tool === 'list_channels')).toHaveLength(3);
    for (const l of out.lines()) expect(l).toMatchObject({ tool: 'list_channels', outcome: 'error', reason: 'bad_input' });
  });

  it('an upstream failure is reported by kind only through the whole stack', async () => {
    const env = mcpEnv();
    api.reply.current = (_q, res) => json(res, 404, `{"message":"actionId '${tp.uuid.a}' not found for identityId 'ID-CANARY'","compositeFault":null}`);
    const { s, out, err } = await boot(env);
    const r = await call(era, s.port, f.raw.tA, 'list_channels', { profile: 'a', agreement: 'billing' });
    expect(r).toMatchObject({ isError: true, content: [{ type: 'text', text: 'tool failed: agreement_not_found' }] });
    expect(out.lines().at(-1)).toMatchObject({ outcome: 'error', reason: 'agreement_not_found' });
    expect(`${texts(r)}${out.text()}${err.join('')}`).not.toMatch(new RegExp(`ID-CANARY|identityId|${tp.uuid.a}`));
  });

  it('whoami lists the profiles in config order, id and country only', async () => {
    const env = mcpEnv();
    const { s } = await boot(env);
    const r = await call(era, s.port, f.raw.tA, 'whoami', {});
    expect(r.structuredContent).toMatchObject({ profiles: [{ id: 'a', country: 'SE' }, { id: 'b', country: 'SE' }] });
    expect(whoamiOutput.strict().parse(r.structuredContent)).toBeTruthy();
    expect(texts(r)).not.toMatch(/agreements|clientId|"cert"/);
    for (const u of Object.values(tp.uuid)) expect(texts(r)).not.toContain(u);
  });
});

describe('configuration errors refuse to start before anything opens', () => {
  const cases: [string, (env: Record<string, string | undefined>, t: TwoProfiles) => Record<string, string | undefined>, string][] = [
    ['STRALFORS_PROFILES absent', (e) => ({ ...e, STRALFORS_PROFILES: undefined }), 'missing STRALFORS_PROFILES'],
    ['STRALFORS_PROFILES only separators', (e) => ({ ...e, STRALFORS_PROFILES: ' , ,' }), 'STRALFORS_PROFILES is empty'],
    ['a CERT_FILE unreadable', (e) => ({ ...e, STRALFORS_PROFILE_A_CERT_FILE: join(dir, 'nope') }), 'cannot read file of STRALFORS_PROFILE_A_CERT_FILE'],
    ['a ACTION_IDS invalid', (e) => ({ ...e, STRALFORS_PROFILE_A_ACTION_IDS: 'x:not-a-uuid' }), 'STRALFORS_PROFILE_A_ACTION_IDS: invalid agreement id (entry 1)'],
    ['STRALFORS_ENV staging', (e) => ({ ...e, STRALFORS_ENV: 'staging' }), 'STRALFORS_ENV is invalid'],
    ['prod with write', (e) => ({ ...e, STRALFORS_ENV: 'prod', STRALFORS_ALLOW_WRITE: 'true' }), 'write is never allowed in prod (STRALFORS_ALLOW_WRITE)'],
    // R-37: the composition root refuses PROD writes itself, before settings it reads later (here an invalid metrics host) and before loadConfig,
    // whose own refusal has its own test in config.test.ts; removing either refusal alone fails a test
    ['prod with write, refused by the composition root first', (e) => ({ ...e, STRALFORS_ENV: 'prod', STRALFORS_ALLOW_WRITE: 'true', MCP_METRICS_HOST: ' ' }), 'write is never allowed in prod (STRALFORS_ALLOW_WRITE)'],
    ['MCP_RATE_PER_MINUTE 0', (e) => ({ ...e, MCP_RATE_PER_MINUTE: '0' }), 'MCP_RATE_PER_MINUTE is invalid'],
    ['MCP_RATE_PER_MINUTE 1.5', (e) => ({ ...e, MCP_RATE_PER_MINUTE: '1.5' }), 'MCP_RATE_PER_MINUTE is invalid'],
    ['MCP_RATE_BURST -1', (e) => ({ ...e, MCP_RATE_BURST: '-1' }), 'MCP_RATE_BURST is invalid'],
    ['MCP_RATE_BURST 0', (e) => ({ ...e, MCP_RATE_BURST: '0' }), 'MCP_RATE_BURST is invalid'],
    ['MCP_TOKEN_STALE_MS abc', (e) => ({ ...e, MCP_TOKEN_STALE_MS: 'abc' }), 'MCP_TOKEN_STALE_MS is invalid'],
    ['MCP_TOKEN_STALE_MS 0', (e) => ({ ...e, MCP_TOKEN_STALE_MS: '0' }), 'MCP_TOKEN_STALE_MS is invalid'],
  ];
  it.each(cases)('%s', async (_n, mutate, text) => {
    const env = mutate(mcpEnv(), tp);
    const reads: string[] = [];
    const factory = vi.fn(real);
    const listen = vi.spyOn(Server.prototype, 'listen');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const e = await start(env, { readFile: (p) => (reads.push(p), readFileSync(p, 'utf8')), clientFactory: factory, audit: sink().audit, now: () => T, onSignal: () => undefined }).then((x) => (started.push(x), undefined), (x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toBe(text);
    expect(reads).not.toContain(tokenFile); // the token store was never created
    expect(factory).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled(); // nothing was opened, so nothing is closed
  });

  it('a token list error after a valid Stralfors config rejects with the token list text; no client is created', async () => {
    const env = mcpEnv();
    writeFileSync(tokenFile, '{');
    const factory = vi.fn(real);
    const e = await boot(env, { clientFactory: factory }).then(() => undefined, (x: unknown) => x);
    expect((e as Error).message).toMatch(/^token list: /);
    expect(factory).not.toHaveBeenCalled();
  });

  it('a client construction failure closes the clients and the store it opened, and never listens', async () => {
    const env = mcpEnv();
    const order: string[] = [];
    const a = stub('a', order);
    const listen = vi.spyOn(Server.prototype, 'listen');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    await expect(boot(env, { clientFactory: (o) => { if (o.profileId === 'b') throw new Error('construct'); return a; } })).rejects.toThrow('construct');
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(listen).not.toHaveBeenCalled();
  });

  it('a listen failure closes every client and the store', async () => {
    const env = mcpEnv();
    const first = await boot(env, { clientFactory: () => stub('x') });
    const clients = [stub('a'), stub('b')];
    const clear = vi.spyOn(globalThis, 'clearInterval');
    await expect(boot({ ...env, MCP_PORT: String(first.s.port) }, { clientFactory: (o) => clients[o.profileId === 'a' ? 0 : 1]! })).rejects.toThrow();
    for (const c of clients) expect(c.close).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe('shutdown', () => {
  const withExitCode = async (fn: () => Promise<void>) => {
    const prev = process.exitCode;
    process.exitCode = 5;
    try {
      await fn();
    } finally {
      process.exitCode = prev;
    }
  };

  it('drain -> clients (in order) -> store; an in-flight call completes first; exit code 0', async () => {
    const env = mcpEnv({ MCP_DRAIN_MS: '5000', MCP_HEARTBEAT_S: '0' });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const clients: Record<string, StralforsClient> = {
      a: stub('a', order, { channels: async () => (entered(), await gate, order.push('channels done'), ['x']) }),
      b: stub('b', order),
    };
    const orig = clearInterval;
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((h: never) => (order.push('store'), orig(h))) as never);
    let signal!: () => void;
    await withExitCode(async () => {
      const { s } = await boot(env, { clientFactory: (o) => clients[o.profileId]!, onSignal: (fn) => void (signal = fn) });
      const inflight = call('modern', s.port, f.raw.tA, 'list_channels', { profile: 'a' });
      void inflight.catch(() => undefined);
      await inside;
      signal();
      const ready = await send(s.port, { method: 'GET', path: '/readyz', headers: { host: '127.0.0.1' } }).then((r) => r.status, () => 503);
      expect(ready).toBe(503);
      expect(order).toEqual([]);
      release();
      expect((await inflight).structuredContent).toEqual({ profile: 'a', channels: ['x'] });
      await s.close();
      expect(process.exitCode).toBe(0);
    });
    expect(order).toEqual(['channels done', 'close a', 'close b', 'store']);
  });

  it('a client close failure still closes the store, sets exit code 1 and rejects Started.close()', async () => {
    const env = mcpEnv({ MCP_HEARTBEAT_S: '0' }); // the heartbeat's clearInterval would be logged as the store's
    const order: string[] = [];
    const clients: Record<string, StralforsClient> = { a: stub('a', order), b: stub('b', order, { close: async () => { order.push('close b'); throw new Error('close failed'); } }) };
    const orig = clearInterval;
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((h: never) => (order.push('store'), orig(h))) as never);
    let signal!: () => void;
    await withExitCode(async () => {
      const { s } = await boot(env, { clientFactory: (o) => clients[o.profileId]!, onSignal: (fn) => void (signal = fn) });
      signal();
      await expect(s.close()).rejects.toThrow();
      expect(process.exitCode).toBe(1);
    });
    expect(order.slice(0, 3)).toEqual(['close a', 'close b', 'store']);
  });

  it('clients and the store are still closed when the HTTP drain throws', async () => {
    const order: string[] = [];
    const clients: Record<string, StralforsClient> = { a: stub('a', order), b: stub('b', order) };
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const { s } = await boot(mcpEnv(), { clientFactory: (o) => clients[o.profileId]! });
    vi.spyOn(Server.prototype, 'closeAllConnections').mockImplementation(() => { throw new Error('drain failed'); });
    await expect(s.close()).rejects.toThrow('drain failed');
    expect(order).toEqual(['close a', 'close b']);
    expect(clear).toHaveBeenCalled();
  });

  it('every client is closed even when the first close rejects (allSettled)', async () => {
    const env = mcpEnv();
    const a = stub('a', [], { close: vi.fn(async () => { throw new Error('x'); }) });
    const b = stub('b');
    const { s } = await boot(env, { clientFactory: (o) => (o.profileId === 'a' ? a : b) });
    await expect(s.close()).rejects.toThrow();
    expect(b.close).toHaveBeenCalledTimes(1);
  });
});

describe('new environment variables', () => {
  const posts = async (port: number, n: number) => {
    const out: Awaited<ReturnType<typeof send>>[] = [];
    for (let i = 0; i < n; i++) out.push(await send(port, { headers: { ...MCP_HEADERS, host: '127.0.0.1', authorization: `Bearer ${f.raw.tA}` }, body: INIT }));
    return out;
  };

  it('defaults: 120 per minute, burst 30 (the 31st request is 429 on a frozen clock)', async () => {
    const { s } = await boot(mcpEnv());
    const r = await posts(s.port, 31);
    expect(r.slice(0, 30).every((x) => x.status === 200)).toBe(true);
    expect(r[30]!.status).toBe(429);
    expect(r[30]!.headers['retry-after']).toBe('1');
  });

  it('MCP_RATE_PER_MINUTE and MCP_RATE_BURST are honoured', async () => {
    const { s } = await boot(mcpEnv({ MCP_RATE_PER_MINUTE: '1', MCP_RATE_BURST: '2' }));
    const r = await posts(s.port, 3);
    expect(r.map((x) => x.status)).toEqual([200, 200, 429]);
    expect(r[2]!.headers['retry-after']).toBe('60');
  });

  it('the limiter uses the injected monotonic clock', async () => {
    let t = 0;
    const { s } = await boot(mcpEnv({ MCP_RATE_PER_MINUTE: '60', MCP_RATE_BURST: '1' }), { monotonic: () => t });
    expect((await posts(s.port, 2)).map((x) => x.status)).toEqual([200, 429]);
    t += 1000;
    expect((await posts(s.port, 1))[0]!.status).toBe(200);
  });

  it('the limiter ignores the wall clock stepping backwards', async () => {
    let wall = T;
    let mono = 0;
    const { s } = await boot(mcpEnv({ MCP_RATE_PER_MINUTE: '60', MCP_RATE_BURST: '1' }), { now: () => wall, monotonic: () => mono });
    expect((await posts(s.port, 2)).map((x) => x.status)).toEqual([200, 429]);
    wall -= 3_600_000;
    mono += 1000;
    expect((await posts(s.port, 1))[0]!.status).toBe(200);
  });
});

describe('token list staleness wiring', () => {
  const MIN = 60_000;
  // the stale line is a structured logger line (warn, fixed msg), not raw stderr text
  const staleLine = (x: string) => x.startsWith('{') && (JSON.parse(x) as { msg?: string }).msg === 'token_list.stale';
  const scenario = async (extra: Record<string, string>, minutes: number) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const env = mcpEnv(extra);
      let t = T;
      const { s, err } = await boot(env, { now: () => t });
      writeFileSync(tokenFile, '{');
      const seen: number[] = [];
      for (let m = 1; m <= minutes; m++) {
        t += MIN;
        vi.advanceTimersByTime(MIN);
        seen.push(err.filter((x) => staleLine(x)).length);
      }
      return { s, err, seen };
    } finally {
      vi.useRealTimers();
    }
  };

  it('default bound 900000 ms: one structured warn line at the 15th failed reload, never raw text, readiness unaffected', async () => {
    const { s, err, seen } = await scenario({}, 18);
    expect(seen.indexOf(1)).toBe(14);
    expect(seen.at(-1)).toBe(1);
    expect(err).not.toContain('token_list.stale\n');
    expect(err.filter(staleLine).map((x) => JSON.parse(x) as Record<string, unknown>)).toEqual([expect.objectContaining({ level: 40, msg: 'token_list.stale' })]);
    expect((await send(s.port, { method: 'GET', path: '/readyz', headers: { host: '127.0.0.1' } })).status).toBe(200);
    expect((await call('modern', s.port, f.raw.tA, 'whoami', {})).isError).toBeUndefined();
  });

  it('MCP_TOKEN_STALE_MS overrides the bound', async () => {
    const { seen } = await scenario({ MCP_TOKEN_STALE_MS: '120000' }, 4);
    expect(seen).toEqual([0, 1, 1, 1]);
  });
});

describe('shutdown sequence (R-04)', () => {
  /** records every armed timer and never fires one by itself */
  const manual = () => {
    const t = {
      ms: [] as number[], fns: [] as (() => void)[], released: false,
      /** cleanup for a `finally`: fires every pending timer and every one armed later, so a failed assertion cannot leave close() hanging */
      release: () => { t.released = true; t.fns.forEach((f) => f()); },
      timer: ((fn: () => void, n: number) => (t.ms.push(n), t.fns.push(fn), t.released && fn(), { unref: () => undefined, ref: () => undefined, hasRef: () => false })) as unknown as typeof setTimeout,
    };
    return t;
  };
  const fire = (t: ReturnType<typeof manual>, ms: number) => t.fns[t.ms.indexOf(ms)]!();
  const probe = (port: number) => send(port, { method: 'GET', path: '/readyz', headers: { host: '127.0.0.1' } }).then((r) => r.status, () => 'refused' as const);

  it.each([['-1'], ['120001'], ['1.5'], ['abc'], ['']])('MCP_READY_DELAY_MS=%j is refused with a ConfigError before anything is started', async (v) => {
    const factory = vi.fn(real);
    const e = await boot(mcpEnv({ MCP_READY_DELAY_MS: v }), { clientFactory: factory }).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toBe('MCP_READY_DELAY_MS is invalid');
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([['0'], ['120000']])('MCP_READY_DELAY_MS=%s is accepted', async (v) => {
    const t = manual();
    const s = await boot(mcpEnv({ MCP_READY_DELAY_MS: v }), { timer: t.timer });
    const closing = s.s.close();
    try {
      if (v !== '0') fire(t, Number(v)); // the delay timer is armed by close(); a timer that never fires would hang it
    } catch (e) {
      t.release(); // a failed assertion must not leave close() hanging
      await closing.catch(() => undefined);
      throw e;
    }
    await closing;
  });

  it('SIGTERM: /readyz is 503 and the port still accepts for MCP_READY_DELAY_MS; the listener closes only after the delay; exit code 0', async () => {
    const t = manual();
    let signal!: () => void;
    const prev = process.exitCode;
    let s: Awaited<ReturnType<typeof boot>>['s'] | undefined;
    try {
      ({ s } = await boot(mcpEnv({ MCP_READY_DELAY_MS: '5000' }), { timer: t.timer, onSignal: (fn) => void (signal = fn) }));
      signal();
      await vi.waitFor(() => expect(t.ms).toContain(5000));
      expect(await probe(s.port)).toBe(503);
      expect((await send(s.port, { headers: { ...MCP_HEADERS, host: '127.0.0.1', authorization: `Bearer ${f.raw.tA}` }, body: INIT })).status).toBe(200); // new work is still accepted
      fire(t, 5000);
      await s.close();
      expect(await probe(s.port)).toBe('refused');
      await vi.waitFor(() => expect(process.exitCode).toBe(0));
    } finally {
      t.release();
      await s?.close().catch(() => undefined);
      process.exitCode = prev;
    }
  });

  it('a client whose close never settles is abandoned after 3000 ms: close() resolves, the other client was closed, the abandonment is not an error', async () => {
    const t = manual();
    const order: string[] = [];
    const clients: Record<string, StralforsClient> = { a: stub('a', order, { close: () => new Promise<void>(() => undefined) }), b: stub('b', order) };
    const { s } = await boot(mcpEnv(), { clientFactory: (o) => clients[o.profileId]!, timer: t.timer });
    const closing = s.close();
    try {
      await vi.waitFor(() => expect(t.ms).toContain(3000));
      expect(order).toEqual(['close b']);
      fire(t, 3000);
      await vi.waitFor(() => expect(t.ms).toContain(5000)); // the telemetry flush bound is armed only after the clients are done
      fire(t, 5000);
      await expect(closing).resolves.toBeUndefined();
    } finally {
      t.release();
      await closing.catch(() => undefined);
    }
  });

  it('a client that rejects at once still makes close() fail with "client close failed" while another client hangs past 3000 ms', async () => {
    const t = manual();
    const clients: Record<string, StralforsClient> = { a: stub('a', [], { close: () => Promise.reject(new Error('boom')) }), b: stub('b', [], { close: () => new Promise<void>(() => undefined) }) };
    const { s } = await boot(mcpEnv(), { clientFactory: (o) => clients[o.profileId]!, timer: t.timer });
    const closing = s.close().then(() => undefined, (e: unknown) => e as Error);
    try {
      await vi.waitFor(() => expect(t.ms).toContain(3000));
      fire(t, 3000);
    } finally {
      t.release();
    }
    expect((await closing)?.message).toBe('client close failed');
  });

  it('the 3000 ms client bound is cleared once the clients are done, so no timer outlives close()', async () => {
    const t = manual();
    const handles: unknown[] = [];
    const timer = ((fn: () => void, n: number) => (handles.push(t.timer(fn, n)), handles.at(-1))) as unknown as typeof setTimeout;
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const { s } = await boot(mcpEnv(), { clientFactory: (o) => stub(o.profileId), timer });
      await s.close();
      expect(clear).toHaveBeenCalledWith(handles[t.ms.indexOf(3000)]);
    } finally {
      clear.mockRestore();
    }
  });

  it('a prompt close arms the 3000 ms client bound once and the 5000 ms flush bound once', async () => {
    const t = manual();
    const { s } = await boot(mcpEnv(), { clientFactory: (o) => stub(o.profileId), timer: t.timer });
    await s.close();
    expect(t.ms.filter((n) => n === 3000)).toEqual([3000]);
    expect(t.ms.filter((n) => n === 5000)).toEqual([5000]);
  });
});

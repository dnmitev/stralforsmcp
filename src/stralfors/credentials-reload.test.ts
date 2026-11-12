/*
 * 02-06 mTLS cert/key hot-swap. API under test:
 *   CreateClientOptions { readFile?(path): string; setTimer?(fn, ms): handle; clearTimer?(handle): void; createAgent?: typeof createAgent }
 *     (timer seams mirror createTokenStore; the default timer is an unref'd setInterval of config.certReloadS * 1000)
 *   client.reloadCredentials(): void   one synchronous tick: read cert/key/passphrase files (Profile.files), compare trimmed content with
 *     the current material, unchanged -> nothing; else createAgent, swap, old.close() (never destroy). Failure keeps the last good agent
 *     and warns `credentials.reload_failed` {profile, kind: 'read'|'empty'|'pem'|'key'} once per distinct failure.
 *   client.close(): clears the timer first, then closes the agent; a reload after (or during) close creates no agent.
 */
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { inspect } from 'node:util';
import type { Dispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.ts';
import { TlsError } from './errors.ts';
import { createAgent, createClient } from './index.ts';
import { canary, makeEnv, memoryLogger } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

let pki: Pki;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());

interface Seen { url: string; cn: string }
/** mTLS server whose client trust can be switched while it runs (rotation: CA-A -> CA-B). Token endpoint included. */
async function serve() {
  const seen: Seen[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let arrived!: () => void;
  const held = new Promise<void>((r) => (arrived = r));
  const server: Server = createServer(
    { key: pki.server.key, cert: pki.server.cert, ca: pki.ca, requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const peer = (req.socket as unknown as { getPeerCertificate(): { subject?: { CN?: string } } }).getPeerCertificate();
      seen.push({ url: req.url ?? '', cn: peer.subject?.CN ?? '' });
      req.resume();
      const reply = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.url === '/v1/oidc/token' ? JSON.stringify({ access_token: `tok-${seen.length}`, expires_in: 3600 }) : '{"ok":true}');
      };
      if (req.url === '/rest/hold') {
        arrived();
        void gate.then(reply);
      } else reply();
    },
  );
  server.on('tlsClientError', () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    trust: (ca: string) => server.setSecureContext({ key: pki.server.key, cert: pki.server.cert, ca }),
    release, held,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
type Server_ = Awaited<ReturnType<typeof serve>>;
let srv: Server_ | undefined;
const open = async () => (srv = await serve());
afterEach(async () => {
  vi.restoreAllMocks();
  await srv?.close();
  srv = undefined;
});

/** Client on files in a fresh dir, with a manual timer and an agent factory spy that records every agent and the close order. */
function build(extra: Record<string, string> = {}, opts: { readFile?: (p: string) => string; clock?: { t: number } } = {}) {
  const f = makeEnv(pki, { id: 'a', extra });
  const config = loadConfig(f.env);
  const paths = { cert: f.env['STRALFORS_PROFILE_A_CERT_FILE']!, key: f.env['STRALFORS_PROFILE_A_KEY_FILE']!, passphrase: f.env['STRALFORS_PROFILE_A_KEY_PASSPHRASE_FILE']! };
  const order: string[] = [];
  const agents: Dispatcher[] = [];
  const closed: boolean[] = [];
  const factory = vi.fn((p: Parameters<typeof createAgent>[0], o?: Parameters<typeof createAgent>[1]) => {
    const a = createAgent(p, o);
    const i = agents.push(a) - 1;
    const close = a.close.bind(a) as (cb?: () => void) => Promise<void> | void;
    // undici's promise-form close() re-enters this.close(cb): forward the callback form untouched and log only the outer call
    (a as unknown as { close: (cb?: () => void) => Promise<void> | void }).close = (cb?: () => void) => {
      if (cb) return close(cb);
      order.push('agent.close');
      return (close() as Promise<void>).then(() => void (closed[i] = true));
    };
    return a;
  });
  const timers: { fn: () => void; ms: number }[] = [];
  const mem = memoryLogger();
  const clock = opts.clock ?? { t: Date.now() };
  const client = createClient({
    config, profileId: 'a', ca: pki.ca, baseUrl: srv?.url, logger: mem.logger, now: () => clock.t,
    createAgent: factory as typeof createAgent, readFile: opts.readFile,
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
    clearTimer: (h) => void order.push(h === timers[0] ? 'timer.clear' : 'timer.clear?'),
  });
  const failures = () => mem.lines().filter((l) => l['msg'] === 'credentials.reload_failed');
  const rotate = () => {
    writeFileSync(paths.cert, pki.foreignClient.cert);
    writeFileSync(paths.key, pki.foreignClient.key);
  };
  return { client, config, paths, order, agents, closed, factory, timers, mem, failures, rotate, clock, dir: f.dir, passphrase: f.passphrase };
}
const ok = (c: { client: { get(p: string): Promise<unknown> } }) => c.client.get('/rest/ping');

describe('AC-1 rotated cert is used without restart', () => {
  it('after one tick the next request and the token fetch present the new certificate', async () => {
    const s = await open();
    const c = build();
    await expect(ok(c)).resolves.toEqual({ ok: true });
    expect(s.seen.map((r) => r.cn)).toEqual(['client', 'client']); // token + api
    c.rotate();
    s.trust(pki.foreignCa); // the server now trusts only CA-B
    c.clock.t += 4_000_000; // token expired: the next request fetches a new one
    expect(c.timers).toHaveLength(1);
    c.timers[0]!.fn();
    expect(c.factory).toHaveBeenCalledTimes(2);
    await expect(ok(c)).resolves.toEqual({ ok: true });
    expect(s.seen.slice(2).map((r) => [r.url, r.cn])).toEqual([['/v1/oidc/token', 'fclient'], ['/rest/ping', 'fclient']]);
    await c.client.close();
  });

  it('reloadCredentials() is the same tick as the timer', async () => {
    await open();
    const c = build();
    c.rotate();
    c.client.reloadCredentials();
    expect(c.factory).toHaveBeenCalledTimes(2);
    await c.client.close();
  });

  it('the old agent is closed (not destroyed) only after its in-flight request finishes', async () => {
    const s = await open();
    const c = build();
    await ok(c); // proves the old agent, token cached
    const inflight = c.client.get('/rest/hold');
    inflight.catch(() => undefined); // no unhandled rejection if the test fails early
    await s.held;
    c.rotate();
    c.client.reloadCredentials();
    expect(c.order).toEqual(['agent.close']);
    await new Promise((r) => setImmediate(r));
    expect(c.closed[0]).toBeUndefined(); // still draining
    s.release();
    await expect(inflight).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(c.closed[0]).toBe(true));
    // the held request completed on the old agent (asserted above), so it was drained, never force-destroyed
    await c.client.close();
  });

  it('a fresh agent classifies a rejected certificate as TLS again (proven is per agent, ADR 0003)', async () => {
    await open();
    const c = build();
    await ok(c); // old agent is proven by a real response
    c.rotate(); // CA-B cert, but the server still trusts only CA-A
    c.client.reloadCredentials();
    const err = await ok(c).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(TlsError);
    await c.client.close();
  });
});

describe('AC-2 bad files keep the last good agent', () => {
  const cases: [string, 'read' | 'empty' | 'pem' | 'key', (c: ReturnType<typeof build>) => void][] = [
    ['unreadable cert', 'read', (c) => rmSync(c.paths.cert)],
    ['unreadable key', 'read', (c) => rmSync(c.paths.key)],
    ['empty cert', 'empty', (c) => writeFileSync(c.paths.cert, '')],
    ['whitespace-only key', 'empty', (c) => writeFileSync(c.paths.key, ' \n')],
    ['cert that is not PEM', 'pem', (c) => writeFileSync(c.paths.cert, 'this is not a certificate')],
    ['passphrase that does not open the key', 'key', (c) => writeFileSync(c.paths.passphrase, 'wrong-passphrase')],
    ['key that is not PEM', 'key', (c) => writeFileSync(c.paths.key, 'this is not a key')],
    ['cert with a PEM header but invalid contents', 'pem', (c) => writeFileSync(c.paths.cert, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')],
    ['cert that does not belong to the key', 'key', (c) => writeFileSync(c.paths.cert, pki.foreignClient.cert)],
  ];
  it.each(cases)('%s', async (_n, kind, damage) => {
    await open();
    const c = build();
    await ok(c);
    damage(c);
    c.client.reloadCredentials();
    expect(c.factory).toHaveBeenCalledTimes(1);
    expect(c.closed).toEqual([]);
    await expect(ok(c)).resolves.toEqual({ ok: true }); // still the previous agent
    const w = c.failures();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ level: 40, profile: 'a', kind });
    c.client.reloadCredentials(); // identical failure on the next tick: silent
    expect(c.failures()).toHaveLength(1);
    expect(c.factory).toHaveBeenCalledTimes(1);
    expect(c.mem.text()).not.toContain(c.dir); // no path
    await c.client.close();
  });

  it('a distinct failure warns again, and nothing but profile and kind is added to the line', async () => {
    await open();
    const c = build();
    rmSync(c.paths.cert);
    c.client.reloadCredentials();
    writeFileSync(c.paths.cert, '');
    c.client.reloadCredentials();
    expect(c.failures().map((l) => l['kind'])).toEqual(['read', 'empty']);
    const base = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'name', 'profile', 'kind']);
    for (const l of c.failures()) expect(Object.keys(l).filter((k) => !base.has(k))).toEqual([]);
    await c.client.close();
  });

  it('recovery after a failure swaps in the good files', async () => {
    const s = await open();
    const c = build();
    await ok(c);
    writeFileSync(c.paths.cert, '');
    c.client.reloadCredentials();
    c.rotate();
    s.trust(pki.foreignCa);
    c.client.reloadCredentials();
    expect(c.factory).toHaveBeenCalledTimes(2);
    await c.client.close();
  });
});

describe('AC-3 no churn when nothing changed', () => {
  it('same content, also after a rewrite or trailing newlines: no new agent, nothing closed', async () => {
    await open();
    const c = build();
    await ok(c);
    c.client.reloadCredentials();
    writeFileSync(c.paths.cert, readFileSync(c.paths.cert, 'utf8'));
    writeFileSync(c.paths.key, `${readFileSync(c.paths.key, 'utf8')}\n`);
    writeFileSync(c.paths.passphrase, `${c.passphrase}\n`);
    c.client.reloadCredentials();
    expect(c.factory).toHaveBeenCalledTimes(1);
    expect(c.order).toEqual([]);
    expect(c.failures()).toEqual([]);
    await c.client.close();
  });

  it('only the passphrase file changing counts as a change (and fails as a key failure here)', async () => {
    await open();
    const c = build();
    writeFileSync(c.paths.passphrase, 'other');
    c.client.reloadCredentials();
    expect(c.failures().map((l) => l['kind'])).toEqual(['key']);
    await c.client.close();
  });

  it('reads through the readFile seam', () => {
    const read = vi.fn((p: string) => readFileSync(p, 'utf8'));
    const c = build({}, { readFile: read });
    c.client.reloadCredentials();
    expect(read.mock.calls.map((a) => a[0]).sort()).toEqual([c.paths.cert, c.paths.key, c.paths.passphrase].sort());
    void c.client.close();
  });
});

describe('AC-4 timer and shutdown', () => {
  it('polls every certReloadS seconds (default 60)', async () => {
    const d = build();
    expect(d.timers.map((t) => t.ms)).toEqual([60_000]);
    const e = build({ STRALFORS_CERT_RELOAD_S: '7' });
    expect(e.timers.map((t) => t.ms)).toEqual([7_000]);
    await Promise.all([d.client.close(), e.client.close()]);
  });

  it('default timer is an unref\'d interval, cleared by close()', async () => {
    const set = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const config = loadConfig(makeEnv(pki, { id: 'a' }).env);
    const client = createClient({ config, profileId: 'a', ca: pki.ca });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]![1]).toBe(60_000);
    expect((set.mock.results[0]!.value as NodeJS.Timeout).hasRef()).toBe(false);
    await client.close();
    expect(clear).toHaveBeenCalledWith(set.mock.results[0]!.value);
  });

  it('close() clears the timer before it closes the agent', async () => {
    const c = build();
    await c.client.close();
    expect(c.order).toEqual(['timer.clear', 'agent.close']);
  });

  it('a tick after close() creates no agent, even with new files', async () => {
    const c = build();
    await c.client.close();
    c.rotate();
    c.timers[0]!.fn();
    c.client.reloadCredentials();
    expect(c.factory).toHaveBeenCalledTimes(1);
  });

  it('a tick while close() is running creates no agent', async () => {
    const c = build();
    c.rotate();
    const closing = c.client.close(); // synchronous part has run: timer cleared, agent closing
    c.timers[0]!.fn();
    await closing;
    expect(c.factory).toHaveBeenCalledTimes(1);
    expect(c.order).toEqual(['timer.clear', 'agent.close']);
  });
});

describe('AC-5 secrets stay hidden', () => {
  const text = (c: ReturnType<typeof build>, ...more: unknown[]) => [c.mem.text(), ...more.map((m) => (m instanceof Error ? `${m.message}${String(m)}${JSON.stringify(m)}` : inspect(m, { depth: 5 })))].join('\n');

  it('failed reloads with canary file content log neither content, passphrase nor error text', async () => {
    await open();
    const [cc, ck, cp, ce] = ['cert', 'key', 'pass', 'readerr'].map(canary);
    const c = build({}, { readFile: (p) => { throw new Error(`${ce} ${p}`); } });
    c.client.reloadCredentials();
    expect(c.failures()).toHaveLength(1);
    const d = build();
    for (const [file, content] of [[d.paths.cert, cc], [d.paths.key, ck], [d.paths.passphrase, cp]] as const) {
      writeFileSync(file, content);
      d.client.reloadCredentials();
    }
    expect(d.failures().length).toBeGreaterThanOrEqual(2);
    for (const needle of [cc, ck, cp, ce, c.dir, d.dir]) {
      expect(text(c)).not.toContain(needle);
      expect(text(d)).not.toContain(needle);
    }
    await Promise.all([c.client.close(), d.client.close()]);
  });

  it('a successful rotation logs no cert, key or passphrase material', async () => {
    const s = await open();
    const c = build();
    await ok(c);
    c.rotate();
    s.trust(pki.foreignCa);
    c.client.reloadCredentials();
    await ok(c);
    const lines = (m: string) => m.split('\n').filter((l) => l.length > 20 && !l.startsWith('-----'));
    for (const needle of [c.passphrase, ...lines(pki.foreignClient.key), ...lines(pki.foreignClient.cert), ...lines(pki.client.key), ...lines(pki.client.cert)]) {
      expect(c.mem.text()).not.toContain(needle);
    }
    await c.client.close();
  });

  it('the client object does not expose credential material or paths', async () => {
    await open();
    const c = build();
    for (const v of [inspect(c.client, { depth: 5 }), JSON.stringify(c.client), String(c.config), inspect(c.config.profiles['a'], { depth: 5 })]) {
      expect(v).not.toContain(c.dir);
      expect(v).not.toContain(c.passphrase);
    }
    expect(Object.keys(c.config.profiles['a']!)).not.toContain('files');
    await c.client.close();
  });
});

/*
 * R15 entry point. API under test (src/server/main.ts, re-exported by src/index.ts): start(env, deps?) => { port, close }.
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../stralfors/errors.ts';
import * as index from '../index.ts';
import { start, type Started } from './main.ts';
import { connect, send, sink, INIT, MCP_HEADERS, LIST } from '../../test/helpers/server.ts';
import { fixture, T, type Fixture } from '../../test/helpers/token-list.ts';
import { makeEnv } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

// 02-03: a valid Stralfors profile (real temp files, synthetic PKI) is part of every start(). The token list stays the fixture under the path 'x'.
let pki: Pki;
let base: Record<string, string>;
beforeAll(() => {
  pki = generatePki();
  base = { MCP_TOKEN_LIST_FILE: 'x', MCP_HOSTNAMES: '127.0.0.1', MCP_PORT: '0', MCP_METRICS_PORT: '0', MCP_METRICS_HOST: '127.0.0.1', MCP_LISTEN_HOST: '127.0.0.1', ...makeEnv(pki).env };
});
afterAll(() => pki.cleanup());
const route = (f: Fixture) => (p: string) => (p === 'x' ? f.text() : readFileSync(p, 'utf8'));
const started: Started[] = [];
const go = async (env: Record<string, string | undefined>, f = fixture(), extra: Parameters<typeof start>[1] = {}) => {
  const err: string[] = [];
  const s = await start({ ...base, ...env }, { readFile: route(f), stderr: { write: (x) => void err.push(x) }, audit: sink().audit, now: () => T, onSignal: () => undefined, ...extra });
  started.push(s);
  return { s, f, err };
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(started.splice(0).map((s) => s.close()));
});

describe('start', () => {
  it('minimal env starts, serves health and lists whoami for a valid token', async () => {
    const { s, f } = await go({});
    expect((await send(s.port, { method: 'GET', path: '/healthz', headers: { host: '127.0.0.1' } })).text).toBe('ok');
    const fetchWith: typeof fetch = (url, init) => fetch(`http://127.0.0.1:${s.port}/mcp`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${f.raw.tA}` } });
    const c = await connect('modern', fetchWith);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['whoami', 'list_channels']);
    const r = await send(s.port, { headers: { ...MCP_HEADERS, host: '127.0.0.1' }, body: LIST });
    expect(r.status).toBe(401);
  });

  it('a failed listen closes the token store (no leaked reload timer)', async () => {
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const taken = await go({});
    await expect(start({ ...base, MCP_PORT: String(taken.s.port) }, { readFile: route(taken.f), audit: sink().audit, now: () => T, onSignal: () => undefined })).rejects.toThrow();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('index.ts exports start', () => {
    expect(index.start).toBe(start);
    expect(index.serverInfo.name).toBeTypeOf('string');
  });

  it.each([
    [{ MCP_TOKEN_LIST_FILE: undefined }, 'missing MCP_TOKEN_LIST_FILE'],
    [{ MCP_HOSTNAMES: undefined }, 'missing MCP_HOSTNAMES'],
    [{ MCP_HOSTNAMES: ',,' }, 'MCP_HOSTNAMES is invalid'],
    [{ MCP_HOSTNAMES: 'https://a.example' }, 'MCP_HOSTNAMES is invalid'],
    [{ MCP_HOSTNAMES: 'a.example:8080' }, 'MCP_HOSTNAMES is invalid'],
    [{ MCP_ORIGINS: 'https://a.example' }, 'MCP_ORIGINS is invalid'],
    [{ MCP_PORT: '70000' }, 'MCP_PORT is invalid'],
    [{ MCP_PORT: 'abc' }, 'MCP_PORT is invalid'],
    [{ MCP_PORT: '-1' }, 'MCP_PORT is invalid'],
    [{ MCP_MAX_BODY_BYTES: '0' }, 'MCP_MAX_BODY_BYTES is invalid'],
    [{ MCP_MAX_BODY_BYTES: 'x' }, 'MCP_MAX_BODY_BYTES is invalid'],
    [{ MCP_DRAIN_MS: '-1' }, 'MCP_DRAIN_MS is invalid'],
    [{ MCP_DRAIN_MS: '1.5' }, 'MCP_DRAIN_MS is invalid'],
    [{ STRALFORS_ENV: 'staging' }, 'STRALFORS_ENV is invalid'],
    [{ STRALFORS_ENV: undefined }, 'STRALFORS_ENV is invalid'],
    [{ STRALFORS_ENV: 'prod', STRALFORS_ALLOW_WRITE: 'true' }, 'write is never allowed in prod (STRALFORS_ALLOW_WRITE)'],
  ])('invalid configuration %j refuses to start with %j and opens no socket', async (defect, text) => {
    const listen = vi.spyOn(Server.prototype, 'listen');
    await expect(go(defect as Record<string, string | undefined>)).rejects.toSatisfy((e: Error) => e instanceof ConfigError && e.message.includes(text));
    expect(listen).not.toHaveBeenCalled();
  });

  it('an unreadable token list refuses to start', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen');
    await expect(go({}, fixture(), { readFile: (p) => { if (p === 'x') throw new Error('ENOENT secret/path'); return readFileSync(p, 'utf8'); } })).rejects.toSatisfy((e: Error) => e instanceof ConfigError && e.message.includes('token list: cannot read'));
    expect(listen).not.toHaveBeenCalled();
  });

  it('an invalid token list refuses to start, naming only the field path', async () => {
    const f = fixture();
    const list = JSON.parse(f.text());
    list.users[0].role = 'root';
    f.file.content = JSON.stringify(list);
    await expect(go({}, f)).rejects.toSatisfy((e: Error) => e instanceof ConfigError && e.message.includes('token list: users[0].role is invalid') && !e.message.includes(f.raw.tA));
  });

  it('the token list is read from MCP_TOKEN_LIST_FILE', async () => {
    const paths: string[] = [];
    await go({ MCP_TOKEN_LIST_FILE: '/some/where/tokens.json' }, fixture(), { readFile: (p) => (paths.push(p), p === '/some/where/tokens.json' ? fixture().text() : readFileSync(p, 'utf8')) });
    expect(paths).toContain('/some/where/tokens.json');
  });

  it('defaults: origins follow hostnames, body limit 1 MiB, listen host 0.0.0.0', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen');
    const { s } = await go({ MCP_LISTEN_HOST: undefined });
    expect(listen.mock.calls[1]!.slice(0, 2)).toEqual([0, '0.0.0.0']) // [0] is the metrics listener (02-04);
    const h = { ...MCP_HEADERS, host: '127.0.0.1' };
    expect((await send(s.port, { headers: { ...h, origin: 'http://127.0.0.1' }, body: INIT })).status).toBe(401);
    expect((await send(s.port, { headers: { ...h, origin: 'http://evil.example' }, body: INIT })).status).toBe(403);
    expect((await send(s.port, { headers: { ...h, 'content-length': '1048576' }, hold: true })).status).toBe(401);
    expect((await send(s.port, { headers: { ...h, 'content-length': '1048577' }, hold: true })).status).toBe(413);
  });

  it('configured values override the defaults', async () => {
    const { s } = await go({ MCP_ORIGINS: 'app.example.test', MCP_MAX_BODY_BYTES: '50' });
    const h = { ...MCP_HEADERS, host: '127.0.0.1' };
    expect((await send(s.port, { headers: { ...h, origin: 'https://app.example.test' }, body: INIT })).status).toBe(413);
    expect((await send(s.port, { headers: { ...h, origin: 'http://127.0.0.1' }, body: INIT })).status).toBe(403);
  });

  it('hostnames are trimmed and deduplicated', async () => {
    const { s } = await go({ MCP_HOSTNAMES: ' a.example , b.example,a.example ' });
    for (const host of ['a.example', 'b.example']) expect((await send(s.port, { headers: { ...MCP_HEADERS, host }, body: INIT })).status).toBe(401);
    expect((await send(s.port, { headers: { ...MCP_HEADERS, host: '127.0.0.1' }, body: INIT })).status).toBe(403);
  });

  it('hostname allowlist entries are lowercased (the SDK sees a lowercased Host)', async () => {
    const { s } = await go({ MCP_HOSTNAMES: 'LOCALHOST,Mcp.Example.TEST' });
    for (const host of ['localhost:3000', 'localhost', 'mcp.example.test']) expect((await send(s.port, { headers: { ...MCP_HEADERS, host }, body: INIT })).status).toBe(401);
    expect((await send(s.port, { headers: { ...MCP_HEADERS, host: '127.0.0.1' }, body: INIT })).status).toBe(403);
  });

  it('entries differing only in case are deduplicated', async () => {
    const { s } = await go({ MCP_HOSTNAMES: ' A.Example , a.example ' });
    expect((await send(s.port, { headers: { ...MCP_HEADERS, host: 'a.example' }, body: INIT })).status).toBe(401);
    expect((await send(s.port, { headers: { ...MCP_HEADERS, host: 'b.example' }, body: INIT })).status).toBe(403);
  });

  it.each(['[::1]', '::1'])('IPv6 allowlist entry %s matches Host [::1]', async (entry) => {
    const { s } = await go({ MCP_HOSTNAMES: entry });
    expect((await send(s.port, { headers: { ...MCP_HEADERS, host: '[::1]' }, body: INIT })).status).toBe(401);
    expect((await send(s.port, { headers: { ...MCP_HEADERS, host: '[::1]:8443' }, body: INIT })).status).toBe(401);
    expect((await send(s.port, { headers: { ...MCP_HEADERS, host: '[::2]' }, body: INIT })).status).toBe(403);
  });

  it('full-form IPv6 without :: is accepted; bad IPv6 or hostnames are refused with a fixed message', async () => {
    const { s } = await go({ MCP_HOSTNAMES: '2001:db8:0:0:0:0:0:1' });
    expect((await send(s.port, { headers: { ...MCP_HEADERS, host: '[2001:db8::1]' }, body: INIT })).status).toBe(401);
    for (const bad of ['[::1', '::1]', '[::1]:80', ':::', '1:2', 'a b', '[a.example]', '-', '.', 'fe80::1%eth0', '[fe80::1%eth0]']) {
      await expect(start({ ...base, MCP_HOSTNAMES: bad }, { readFile: route(fixture()), audit: sink().audit, now: () => T, onSignal: () => undefined })).rejects.toThrow(new ConfigError('MCP_HOSTNAMES is invalid'));
    }
  });

  it('a close() failure in the signal handler sets exitCode 1 and does not crash', async () => {
    let handler: (() => void) | undefined;
    const prev = process.exitCode;
    process.exitCode = 0;
    try {
      const s = await start({ ...base }, { readFile: route(fixture()), audit: sink().audit, now: () => T, onSignal: (fn) => void (handler = fn) });
      vi.spyOn(Server.prototype, 'closeAllConnections').mockImplementation(() => { throw new Error('boom'); });
      handler!();
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
      await expect(s.close()).rejects.toThrow('boom');
    } finally {
      process.exitCode = prev;
    }
  });

  it('SIGTERM handler: readiness flips, close resolves, exitCode is 0 (process.exit is never called)', async () => {
    let handler: (() => void) | undefined;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const prev = process.exitCode;
    process.exitCode = 5;
    try {
      const { s } = await go({ MCP_DRAIN_MS: '2000' }, fixture(), { onSignal: (fn) => void (handler = fn) });
      expect(handler).toBeTypeOf('function');
      handler!();
      const ready = await send(s.port, { method: 'GET', path: '/readyz' }).then((r) => r.status, () => 503);
      expect(ready).toBe(503);
      await vi.waitFor(() => expect(process.exitCode).toBe(0));
      expect(exit).not.toHaveBeenCalled();
      expect(await new Promise<boolean>((r) => { const c = createConnection({ port: s.port, host: '127.0.0.1' }); c.once('error', () => r(true)); c.once('connect', () => (c.destroy(), r(false))); })).toBe(true);
    } finally {
      process.exitCode = prev;
    }
  });

  it('a second signal during drain does nothing extra', async () => {
    let handler: (() => void) | undefined;
    const { s } = await go({}, fixture(), { onSignal: (fn) => void (handler = fn) });
    handler!();
    expect(() => handler!()).not.toThrow();
    await s.close();
  });
});

describe('process entry', () => {
  it('node src/server/main.ts with an unreadable token list exits 1 with a fixed message', () => {
    const r = spawnSync(process.execPath, ['src/server/main.ts'], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { PATH: process.env.PATH ?? '', MCP_TOKEN_LIST_FILE: '/nonexistent-dir/tokens.json', MCP_HOSTNAMES: '127.0.0.1', MCP_PORT: '0', ...makeEnv(pki).env },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing to start: token list: cannot read');
    expect(r.stderr).not.toContain('nonexistent-dir');
  });

  it('an invalid Stralfors configuration exits 1 with a fixed message that names no path', () => {
    const r = spawnSync(process.execPath, ['src/server/main.ts'], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { PATH: process.env.PATH ?? '', MCP_TOKEN_LIST_FILE: '/nonexistent-dir/tokens.json', MCP_HOSTNAMES: '127.0.0.1', MCP_PORT: '0', STRALFORS_ENV: 'test' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing to start: missing STRALFORS_PROFILES');
    expect(r.stderr).not.toContain('nonexistent-dir');
  });

  it('missing configuration exits 1', () => {
    const r = spawnSync(process.execPath, ['src/server/main.ts'], { cwd: new URL('../..', import.meta.url).pathname, env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing to start: missing MCP_TOKEN_LIST_FILE');
  });

  it('starts when launched through a symlinked path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smcp-entry-'));
    try {
      const link = join(dir, 'main-link.ts');
      symlinkSync(fileURLToPath(new URL('./main.ts', import.meta.url)), link);
      const r = spawnSync(process.execPath, [link], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 20_000 });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('refusing to start: missing MCP_TOKEN_LIST_FILE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/*
 * 02-08 red tests: the .mcpb stdio bridge against the real in-process server (no Docker, no live Stralfors), token and URL rules,
 * stdout purity, and the bundle (manifest schema, single-file bridge, zip entries). Tokens are generated at run time.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { generateToken } from '../src/auth/index.ts';
import { useStartWorld } from './helpers/start.ts';
import { LINES, bundle, callWhoami, cleanupBundle, connectBridge, destroyingListener, initialize, initialized, listTools, recordingUpstream, runBridge } from './helpers/stdio-bridge.ts';

const W = useStartWorld();
afterAll(cleanupBundle);
const urlOf = (port: number) => `http://127.0.0.1:${port}/mcp`;
const SESSION = [initialize(), initialized, listTools(), callWhoami()];
const text = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`;

describe('AC-1 bridge forwards MCP end to end', () => {
  it('SDK client over stdio: same tools as the server, whoami returns the token user, close resolves', async () => {
    const { s } = await W.boot(W.mcpEnv());
    const direct = await (await import('./helpers/server.ts')).connect('modern', W.bearer(s.port, W.state.f.raw.tA), urlOf(s.port));
    const want = (await direct.listTools()).tools.map((t) => t.name).sort();
    const { client } = await connectBridge({ MCP_URL: urlOf(s.port), MCP_TOKEN: W.state.f.raw.tA });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(want);
    expect(want).toContain('whoami');
    const r = await client.callTool({ name: 'whoami', arguments: {} });
    expect(r.structuredContent).toMatchObject({ name: 'User One', role: 'dev' });
    await client.close();
  });

  it('closing stdin ends the bridge with exit code 0 after a full session', async () => {
    const { s } = await W.boot(W.mcpEnv());
    const r = await runBridge({ MCP_URL: urlOf(s.port), MCP_TOKEN: W.state.f.raw.tA }, SESSION, 3);
    expect(r.code).toBe(0);
    expect(r.frames.map((f) => f.id).filter((i) => i !== undefined).sort()).toEqual([1, 2, 3]); // set of ids: response order is not guaranteed
  });
});

describe('AC-2 token handling', () => {
  it('the valid token reaches the upstream only as the Authorization bearer header', async () => {
    const up = await recordingUpstream();
    const token = generateToken();
    const r = await runBridge({ MCP_URL: up.url, MCP_TOKEN: token }, [initialize()], 1);
    await up.close();
    expect(r.code).toBe(0);
    expect(up.seen.length).toBeGreaterThan(0);
    for (const q of up.seen) {
      expect(q.headers.authorization).toBe(`Bearer ${token}`);
      expect(q.url).not.toContain(token);
      expect(q.body).not.toContain(token);
      expect(Object.entries(q.headers).filter(([k, v]) => k !== 'authorization' && String(v).includes(token))).toEqual([]);
    }
  });

  it('a wrong token gives the fixed authorization error and stderr line, without echoing token or URL', async () => {
    const { s } = await W.boot(W.mcpEnv());
    const wrong = generateToken();
    const r = await runBridge({ MCP_URL: urlOf(s.port), MCP_TOKEN: wrong }, [initialize()], 1);
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]).toMatchObject({ jsonrpc: '2.0', id: 1, error: { message: 'authorization failed (check your token)' } });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`${LINES.auth}\n`);
    expect(text(r)).not.toContain(wrong);
    expect(r.stdout).not.toContain('127.0.0.1');
  });

  it.each([
    ['MCP_TOKEN missing', (u: string) => ({ MCP_URL: u })],
    ['MCP_URL missing', () => ({ MCP_TOKEN: generateToken() })],
    ['both missing', () => ({})],
    ['MCP_TOKEN empty', (u: string) => ({ MCP_URL: u, MCP_TOKEN: '' })],
  ])('%s: exit 1 with the fixed line and no network call', async (_n, mk) => {
    const up = await recordingUpstream();
    const r = await runBridge(mk(up.url), [initialize()]);
    await up.close();
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`${LINES.config}\n`);
    expect(r.stdout).toBe('');
    expect(up.seen).toEqual([]);
  });

  it('canary: no token appears on stdout or stderr over valid, wrong and rejected runs', async () => {
    const { s } = await W.boot(W.mcpEnv());
    const up = await recordingUpstream();
    const dead = await destroyingListener();
    const wrong = generateToken();
    const ok = W.state.f.raw.tA;
    const runs = [
      await runBridge({ MCP_URL: urlOf(s.port), MCP_TOKEN: ok }, SESSION, 3),
      await runBridge({ MCP_URL: urlOf(s.port), MCP_TOKEN: wrong }, [initialize()], 1),
      await runBridge({ MCP_URL: `http://remote.example.test/mcp`, MCP_TOKEN: wrong }, [initialize()]),
      await runBridge({ MCP_URL: `http://user:${wrong}@127.0.0.1:${up.port}/mcp`, MCP_TOKEN: wrong }, [initialize()]),
      await runBridge({ MCP_URL: `http://127.0.0.1:${dead.port}/mcp`, MCP_TOKEN: wrong }, [initialize()], 1), // connection destroyed: transport failure
    ];
    await up.close();
    await dead.close();
    for (const r of runs) for (const t of [ok, wrong]) expect(text(r)).not.toContain(t);
  });
});

// IPv6 loopback availability is probed once; only a recognised "address family unavailable" error counts as unavailable, anything else fails the file
const ipv6 = await destroyingListener('::1').then(async (l) => { await l.close(); return true; }, (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT') return false;
  throw e;
});

describe('AC-3 URL policy', () => {
  // Accepted URLs must pass the policy and then reach the transport: the test listener destroys the connection, so the run ends with the fixed upstream line.
  it.each([['localhost', '127.0.0.1', 'localhost'], ['127.0.0.1', '127.0.0.1', '127.0.0.1']])('http://%s starts and reaches the transport', async (_n, bind, host) => {
    const l = await destroyingListener(bind);
    const r = await runBridge({ MCP_URL: `http://${host}:${l.port}/mcp`, MCP_TOKEN: generateToken() }, [initialize()], 1);
    await l.close();
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`${LINES.upstream}\n`);
    expect(l.connections()).toBeGreaterThan(0);
  });

  // reported as skipped (not passed) when the machine has no IPv6 loopback
  it.skipIf(!ipv6)('http://[::1] starts and reaches the transport', async () => {
    const l = await destroyingListener('::1');
    const r = await runBridge({ MCP_URL: `http://[::1]:${l.port}/mcp`, MCP_TOKEN: generateToken() }, [initialize()], 1);
    await l.close();
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`${LINES.upstream}\n`);
    expect(l.connections()).toBeGreaterThan(0);
  });

  it('an https URL starts and reaches the transport (test-owned listener, TLS handshake fails)', async () => {
    const l = await destroyingListener();
    const r = await runBridge({ MCP_URL: `https://127.0.0.1:${l.port}/mcp`, MCP_TOKEN: generateToken() }, [initialize()], 1);
    await l.close();
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`${LINES.upstream}\n`);
    expect(l.connections()).toBeGreaterThan(0);
  });

  it.each([
    'http://mcp.example.test/mcp',
    'http://192.0.2.1:3000/mcp',
    'http://localhost.example.test/mcp',
    'file:///etc/hosts',
    'javascript:alert(1)',
    'ftp://127.0.0.1/mcp',
    'https://user:pw@mcp.example.test/mcp',
    'http://user@127.0.0.1:3000/mcp',
    'not a url',
  ])('%s: exit 1 with the fixed line, nothing on stdout', async (url) => {
    const r = await runBridge({ MCP_URL: url, MCP_TOKEN: generateToken() }, [initialize()]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`${LINES.url}\n`);
    expect(r.stdout).toBe('');
  });
});

describe('AC-4 stdout is protocol only', () => {
  it('every stdout line is a JSON-RPC frame; stderr is empty on a clean run', async () => {
    const { s } = await W.boot(W.mcpEnv());
    const r = await runBridge({ MCP_URL: urlOf(s.port), MCP_TOKEN: W.state.f.raw.tA }, SESSION, 3);
    const lines = r.stdout.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(JSON.parse(l)).toMatchObject({ jsonrpc: '2.0' });
    expect(r.stderr).toBe('');
  });

  it('transport failure: exit 1, the fixed stderr line only, no URL, path or token in it, stdout still frames only', async () => {
    const token = generateToken();
    const dead = await destroyingListener();
    const r = await runBridge({ MCP_URL: `http://127.0.0.1:${dead.port}/mcp`, MCP_TOKEN: token }, [initialize()], 1);
    await dead.close();
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`${LINES.upstream}\n`);
    for (const l of r.stdout.split('\n').filter(Boolean)) expect(JSON.parse(l)).toMatchObject({ jsonrpc: '2.0' });
    expect(r.frames[0]).toMatchObject({ id: 1, error: expect.anything() });
  });
});

describe('AC-5 the bundle', () => {
  const root = join(import.meta.dirname, '..');

  it('manifest schema (0.3, node server, user_config, privacy, compatibility)', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8')) as Record<string, any>;
    expect(manifest.manifest_version).toBe('0.3');
    for (const k of ['name', 'version', 'description']) expect(typeof manifest[k]).toBe('string');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.author.name).toEqual(expect.any(String));
    expect(manifest.compatibility.runtimes.node).toBe('>=20'); // floor of the bundled SDK engines and the esbuild target
    expect(manifest.server).toMatchObject({ type: 'node', entry_point: 'server/index.js' });
    expect(manifest.server.mcp_config.env).toEqual({ MCP_URL: '${user_config.server_url}', MCP_TOKEN: '${user_config.token}' });
    expect(Object.keys(manifest.user_config).sort()).toEqual(['server_url', 'token']);
    expect(manifest.user_config.server_url).toMatchObject({ type: 'string', required: true });
    expect(manifest.user_config.server_url.sensitive).not.toBe(true);
    expect(manifest.user_config.token).toMatchObject({ type: 'string', required: true, sensitive: true });
    expect(manifest.privacy_policies.length).toBeGreaterThan(0);
    for (const u of manifest.privacy_policies) expect(new URL(u).protocol).toBe('https:');
    expect([...manifest.compatibility.platforms].sort()).toEqual(['darwin', 'win32']);
  });

  it('bundleBridge writes one self-contained file: no external or bare-module imports, no sourcemap', async () => {
    const b = await bundle();
    expect(b.file).toMatch(/server[\\/]index\.js$/);
    const outs = Object.entries(b.metafile.outputs);
    expect(outs).toHaveLength(1);
    expect(outs[0]![0]).not.toMatch(/\.map$/);
    // esbuild marks Node built-ins as external for platform node; anything that is not a node: built-in is a bare module and must be bundled
    expect(outs[0]![1].imports.filter((i) => !i.path.startsWith('node:'))).toEqual([]);
    expect(readFileSync(b.file, 'utf8')).not.toContain('sourceMappingURL');
  });

  it('buildMcpb writes dist/stralforsmcp.mcpb with only manifest, bridge bundle and README/icon', async () => {
    const { buildMcpb } = await import('../scripts/build-mcpb.ts');
    const file = await buildMcpb();
    expect(file).toBe(join(root, 'dist/stralforsmcp.mcpb'));
    const names = Object.keys(unzipSync(new Uint8Array(readFileSync(file)))).sort();
    expect(names).toContain('manifest.json');
    expect(names).toContain('server/index.js');
    expect(names).toContain('server/package.json');
    const allowed = [/^manifest\.json$/, /^server\/index\.js$/, /^server\/package\.json$/, /^README\.md$/, /^icon\.png$/];
    expect(names.filter((n) => !allowed.some((a) => a.test(n)))).toEqual([]);
  });

  it('the extracted archive runs as ESM on its own: reaches the fixed config error line', async () => {
    const { buildMcpb } = await import('../scripts/build-mcpb.ts');
    const files = unzipSync(new Uint8Array(readFileSync(await buildMcpb())));
    const dir = mkdtempSync(join(tmpdir(), 'smcp-extract-'));
    try {
      for (const [n, data] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, n)), { recursive: true });
        writeFileSync(join(dir, n), data);
      }
      const r = spawnSync(process.execPath, [join(dir, 'server/index.js')], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toBe(`${LINES.config}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CLI boundary: a failing build prints one fixed line, exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smcp-badbuild-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, 'extension'));
      copyFileSync(join(root, 'scripts/build-mcpb.ts'), join(dir, 'scripts/build-mcpb.ts'));
      symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
      writeFileSync(join(dir, 'package.json'), '{"type":"module","version":"1.0.0"}');
      writeFileSync(join(dir, 'extension/manifest.json'), '{"version":"2.0.0"}');
      const r = spawnSync(process.execPath, [join(dir, 'scripts/build-mcpb.ts')], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^build-mcpb: build failed: extension\/manifest\.json version differs/);
      expect(r.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

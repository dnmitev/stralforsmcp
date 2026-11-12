/*
 * 02-08 red tests: the .mcpb stdio bridge against the real in-process server (no Docker, no live Stralfors), token and URL rules,
 * stdout purity, and the bundle (manifest schema, single-file bridge, zip entries). Tokens are generated at run time.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { generateToken } from '../src/auth/index.ts';
import { useStartWorld } from './helpers/start.ts';
import { LINES, bundle, callWhoami, cleanupBundle, connectBridge, initialize, initialized, listTools, recordingUpstream, runBridge } from './helpers/stdio-bridge.ts';

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
    expect(r.frames.map((f) => f.id).filter((i) => i !== undefined)).toEqual([1, 2, 3]);
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

  it('a wrong token surfaces the server 401 as a JSON-RPC error without echoing token or URL credentials', async () => {
    const { s } = await W.boot(W.mcpEnv());
    const wrong = generateToken();
    const r = await runBridge({ MCP_URL: urlOf(s.port), MCP_TOKEN: wrong }, [initialize()], 1);
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]).toMatchObject({ jsonrpc: '2.0', id: 1, error: expect.anything() });
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
    const wrong = generateToken();
    const ok = W.state.f.raw.tA;
    const runs = [
      await runBridge({ MCP_URL: urlOf(s.port), MCP_TOKEN: ok }, SESSION, 3),
      await runBridge({ MCP_URL: urlOf(s.port), MCP_TOKEN: wrong }, [initialize()], 1),
      await runBridge({ MCP_URL: `http://remote.example.test/mcp`, MCP_TOKEN: wrong }, [initialize()]),
      await runBridge({ MCP_URL: `http://user:${wrong}@127.0.0.1:${up.port}/mcp`, MCP_TOKEN: wrong }, [initialize()]),
      await runBridge({ MCP_URL: `http://127.0.0.1:1/mcp`, MCP_TOKEN: wrong }, [initialize()], 1), // nothing listens: transport failure
    ];
    await up.close();
    for (const r of runs) for (const t of [ok, wrong]) expect(text(r)).not.toContain(t);
  });
});

describe('AC-3 URL policy', () => {
  const dead = (u: string) => u.replace('PORT', '1'); // accepted URLs point at a closed port: the policy must pass, the network then fails
  it.each(['https://mcp.example.test:1/mcp', 'http://localhost:PORT/mcp', 'http://127.0.0.1:PORT/mcp', 'http://[::1]:PORT/mcp'])('%s starts (no policy line)', async (url) => {
    const r = await runBridge({ MCP_URL: dead(url), MCP_TOKEN: generateToken() }, [initialize()], 1);
    expect(r.stderr).not.toContain(LINES.url);
    expect(r.stderr).not.toContain(LINES.config);
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
    const r = await runBridge({ MCP_URL: 'http://127.0.0.1:1/mcp', MCP_TOKEN: token }, [initialize()], 1);
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
    const allowed = [/^manifest\.json$/, /^server\/index\.js$/, /^README\.md$/, /^icon\.png$/];
    expect(names.filter((n) => !allowed.some((a) => a.test(n)))).toEqual([]);
  });
});

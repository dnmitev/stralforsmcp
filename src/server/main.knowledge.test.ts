// Knowledge wiring: StartDeps.knowledgePublicDir / KNOWLEDGE_DIRS are loaded once in start(); search_docs, resources and prompts are wired.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../stralfors/errors.ts';
import { start, type Started } from './main.ts';
import * as mcp from './mcp.ts';
import type { ToolDef } from './tools.ts';
import { sink } from '../../test/helpers/server.ts';
import { fixture, T } from '../../test/helpers/token-list.ts';
import { makeEnv } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

vi.mock('./mcp.ts', async (orig) => {
  const actual = await orig<typeof import('./mcp.ts')>();
  return { ...actual, buildMcp: vi.fn(actual.buildMcp) };
});

let pki: Pki;
let base: Record<string, string>;
let tmp: string;
beforeAll(() => {
  pki = generatePki();
  tmp = mkdtempSync(join(tmpdir(), 'smcp-know-'));
  base = { MCP_TOKEN_LIST_FILE: 'x', MCP_HOSTNAMES: '127.0.0.1', MCP_PORT: '0', MCP_METRICS_PORT: '0', MCP_METRICS_HOST: '127.0.0.1', MCP_LISTEN_HOST: '127.0.0.1', STRALFORS_ENV: 'test', ...makeEnv(pki).env };
});
afterAll(() => {
  pki.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});
const started: Started[] = [];
afterEach(async () => {
  vi.mocked(mcp.buildMcp).mockClear();
  await Promise.all(started.splice(0).map((s) => s.close()));
});
const dir = (name: string, files: Record<string, string>) => {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
  return d;
};
const md = (id: string, word: string) => `---\nid: ${id}\ntitle: ${word} note\ntags: ${word}\n---\nAbout ${word}.\n`;
const go = async (env: Record<string, string | undefined>, knowledgePublicDir?: string) => {
  const f = fixture();
  const err: string[] = [];
  const s = await start({ ...base, ...env }, { readFile: (p) => (p === 'x' ? f.text() : readFileSync(p, 'utf8')), stderr: { write: (x) => void err.push(x) }, audit: sink().audit, now: () => T, onSignal: () => undefined, ...(knowledgePublicDir === undefined ? {} : { knowledgePublicDir }) });
  started.push(s);
  return err.join('');
};
const searchTool = () => (vi.mocked(mcp.buildMcp).mock.calls[0]![0] as unknown as { tools: ToolDef[] }).tools.find((t) => t.spec.name === 'search_docs')!;
const query = async (q: string) => (await searchTool().run({ query: q }, {} as never)) as { hits: { id: string; source: string }[] };

describe('knowledge wiring', () => {
  it('overlay unset: the shipped public docs only, no private source', async () => {
    const shipped = readdirSync(join(import.meta.dirname, '../../knowledge/public')).filter((f) => f.endsWith('.md')).length;
    const out = await go({ MCP_LOG_LEVEL: 'debug' });
    expect(out).toContain(`knowledge loaded: ${shipped} docs,`);
    expect(searchTool().spec).toEqual({ name: 'search_docs', access: 'read' });
  });
  it('registered for prod too', async () => {
    await go({ STRALFORS_ENV: 'prod' });
    expect(searchTool()).toBeDefined();
  });
  it('overlay set: private docs load, empty entries ignored, same id replaces public', async () => {
    const pub = dir('pub1', { 'a.md': md('shared', 'alpha'), 'b.md': md('only-public', 'bravo') });
    const o1 = dir('ov1', { 'a.md': md('shared', 'charlie') });
    const o2 = dir('ov2', { 'c.md': md('extra', 'delta') });
    await go({ KNOWLEDGE_DIRS: `:${o1}::${o2}:` }, pub);
    expect(await query('charlie')).toMatchObject({ hits: [{ id: 'shared', source: 'private' }] });
    expect((await query('alpha')).hits).toEqual([]);
    expect(await query('delta')).toMatchObject({ hits: [{ id: 'extra', source: 'private' }] });
    expect(await query('bravo')).toMatchObject({ hits: [{ id: 'only-public', source: 'public' }] });
  });
  it('KNOWLEDGE_DIRS of only separators means no overlay', async () => {
    const pub = dir('pub2', { 'a.md': md('p', 'alpha') });
    await go({ KNOWLEDGE_DIRS: '::' }, pub);
    expect((await query('alpha')).hits.map((h) => h.source)).toEqual(['public']);
  });
  it('a bad overlay dir refuses to start with fixed text and no path', async () => {
    const missing = join(tmp, 'CANARYPATH-missing');
    const e = await go({ KNOWLEDGE_DIRS: missing }).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toBe('KNOWLEDGE_DIRS is not readable');
  });
  it('a bad public dir refuses to start with fixed text and no path', async () => {
    const e = await go({}, join(tmp, 'CANARYPATH-nope')).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toBe('knowledge directory is not readable');
  });
  it('stays quiet at the default level when nothing was skipped', async () => {
    const pub = dir('pub4', { 'a.md': md('p', 'alpha') });
    expect(await go({}, pub)).toBe('');
    expect(await go({ MCP_LOG_LEVEL: 'debug' }, pub)).toContain('knowledge loaded: 1 docs, 0 warnings');
  });
  it('logs a count only for skipped private files, never their names or paths', async () => {
    const pub = dir('pub3', { 'a.md': md('p', 'alpha') });
    const ov = dir('ov3', { 'CANARYNAME.md': 'not a doc', 'ok.md': md('q', 'bravo') });
    const out = await go({ KNOWLEDGE_DIRS: ov }, pub);
    expect(out).toContain('knowledge loaded: 2 docs, 1 warnings');
    expect(out).not.toMatch(/CANARYNAME|ov3|pub3/);
  });
  it('names skipped public files in the log, but never a path or content', async () => {
    const pub = dir('pub5', { 'a.md': md('p', 'alpha'), 'PUBBAD.md': 'not a doc CANARYCONTENT' });
    const out = await go({}, pub);
    expect(out).toContain('PUBBAD.md');
    expect(out).toContain('knowledge loaded: 1 docs,');
    expect(out).not.toMatch(/CANARYCONTENT|pub5|smcp-know/);
  });
  it('public names are logged while private names in the same load are not', async () => {
    const pub = dir('pub6', { 'a.md': md('p', 'alpha'), 'PUBBAD.md': 'x' });
    const ov = dir('ov6', { 'PRIVBAD.md': 'y', 'ok.md': md('q', 'bravo') });
    const out = await go({ KNOWLEDGE_DIRS: ov }, pub);
    expect(out).toContain('PUBBAD.md');
    expect(out).not.toContain('PRIVBAD.md');
    expect(out).toContain('knowledge loaded: 2 docs, 2 warnings');
  });
  it('the old KNOWLEDGE_PUBLIC_DIR environment variable is ignored: the shipped docs load', async () => {
    const shipped = readdirSync(join(import.meta.dirname, '../../knowledge/public')).filter((f) => f.endsWith('.md')).length;
    const pub = dir('pub7', { 'a.md': md('only-env', 'alpha') });
    const out = await go({ KNOWLEDGE_PUBLIC_DIR: pub, MCP_LOG_LEVEL: 'debug' });
    expect(out).toContain(`knowledge loaded: ${shipped} docs,`);
  });
  it('the loaded docs reach buildMcp as knowledge.docs for resources and prompts', async () => {
    const pub = dir('pub8', { 'a.md': md('wired', 'alpha') });
    const ov = dir('ov8', { 'b.md': md('wired-private', 'bravo') });
    await go({ KNOWLEDGE_DIRS: ov }, pub);
    const deps = vi.mocked(mcp.buildMcp).mock.calls[0]![0] as unknown as { knowledge?: { docs: { id: string; source: string }[] } };
    expect(deps.knowledge?.docs.map((d) => [d.id, d.source]).sort()).toEqual([['wired', 'public'], ['wired-private', 'private']]);
  });
});

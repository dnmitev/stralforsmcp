import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../auth/index.ts';
import { start, type Started } from './main.ts';
import { connect, sink } from '../../test/helpers/server.ts';
import { fixture, T } from '../../test/helpers/token-list.ts';
import { makeEnv } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

let pki: Pki;
let base: Record<string, string>;
beforeAll(() => {
  pki = generatePki();
  base = { MCP_TOKEN_LIST_FILE: 'x', MCP_HOSTNAMES: '127.0.0.1', MCP_PORT: '0', MCP_METRICS_PORT: '0', MCP_METRICS_HOST: '127.0.0.1', MCP_LISTEN_HOST: '127.0.0.1', ...makeEnv(pki).env };
});
afterAll(() => pki.cleanup());
const started: Started[] = [];
afterEach(async () => void (await Promise.all(started.splice(0).map((s) => s.close()))));
const go = async (env: Record<string, string>) => {
  const f = fixture();
  const err: string[] = [];
  const s = await start({ ...base, ...env }, { readFile: (p) => (p === 'x' ? f.text() : readFileSync(p, 'utf8')), stderr: { write: (x) => void err.push(x) }, audit: sink().audit, now: () => T, onSignal: () => undefined });
  started.push(s);
  return { s, f, err };
};

describe('MCP_LOG_LEVEL', () => {
  it('defaults to info: no debug lines', async () => {
    const { err } = await go({});
    expect(err.join('')).not.toContain('"level":20');
  });
  it('debug adds lines', async () => {
    const { err } = await go({ MCP_LOG_LEVEL: 'debug' });
    expect(err.join('')).toContain('"level":20');
  });
  it.each(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])('accepts %s', async (l) => {
    await go({ MCP_LOG_LEVEL: l });
  });
  it.each(['', 'DEBUG', 'verbose', '10'])('refuses %j naming only the variable', async (v) => {
    await expect(go({ MCP_LOG_LEVEL: v })).rejects.toThrow(/^MCP_LOG_LEVEL is invalid$/);
  });
  it('debug output carries no token, digest or credential file content', async () => {
    const { s, f, err } = await go({ MCP_LOG_LEVEL: 'trace' });
    const fetchWith = (t: string): typeof fetch => (url, init) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${t}` } });
    const c = await connect('modern', fetchWith(f.raw.tA), `http://127.0.0.1:${s.port}/mcp`);
    await c.callTool({ name: 'whoami', arguments: {} });
    await fetch(`http://127.0.0.1:${s.port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${f.raw.tB}`, host: '127.0.0.1' }, body: '{}' });
    const all = err.join('');
    for (const t of Object.values(f.raw)) for (const c2 of [t, hashToken(t)]) expect(all).not.toContain(c2);
    for (const file of Object.keys(base).filter((k) => k.endsWith('_FILE') && k !== 'MCP_TOKEN_LIST_FILE')) expect(all).not.toContain(readFileSync(base[file]!, 'utf8').trim());
  });
});

// MCP_TOOL_OUTPUT_MAX_BYTES and MCP_RULES_CACHE_S: validation and wiring.
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { start, type Started } from './main.ts';
import * as mcp from './mcp.ts';
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
beforeAll(() => {
  pki = generatePki();
  base = { MCP_TOKEN_LIST_FILE: 'x', MCP_HOSTNAMES: '127.0.0.1', MCP_PORT: '0', MCP_METRICS_PORT: '0', MCP_METRICS_HOST: '127.0.0.1', MCP_LISTEN_HOST: '127.0.0.1', ...makeEnv(pki).env };
});
afterAll(() => pki.cleanup());
const started: Started[] = [];
afterEach(async () => {
  vi.mocked(mcp.buildMcp).mockClear();
  await Promise.all(started.splice(0).map((s) => s.close()));
});
const go = async (env: Record<string, string | undefined>) => {
  const f = fixture();
  const s = await start({ ...base, ...env }, { readFile: (p) => (p === 'x' ? f.text() : readFileSync(p, 'utf8')), stderr: { write: () => true }, audit: sink().audit, now: () => T, onSignal: () => undefined });
  started.push(s);
  return s;
};

describe('MCP_TOOL_OUTPUT_MAX_BYTES', () => {
  it('defaults to 262144 and passes a set value on', async () => {
    await go({});
    expect((vi.mocked(mcp.buildMcp).mock.calls[0]![0] as { maxOutputBytes?: number }).maxOutputBytes).toBe(262_144);
    await go({ MCP_TOOL_OUTPUT_MAX_BYTES: '1024' });
    expect((vi.mocked(mcp.buildMcp).mock.calls[1]![0] as { maxOutputBytes?: number }).maxOutputBytes).toBe(1024);
  });
  it.each(['0', 'abc', '-1', '1.5'])('refuses %s', async (v) => {
    await expect(go({ MCP_TOOL_OUTPUT_MAX_BYTES: v })).rejects.toThrow('MCP_TOOL_OUTPUT_MAX_BYTES is invalid');
  });
});

describe('MCP_RULES_CACHE_S', () => {
  it.each(['0', '3600', '86400'])('accepts %s', async (v) => void (await go({ MCP_RULES_CACHE_S: v })));
  it.each(['abc', '-1', '86401', '1.5', ''])('refuses %j', async (v) => {
    await expect(go({ MCP_RULES_CACHE_S: v })).rejects.toThrow('MCP_RULES_CACHE_S is invalid');
  });
});

describe('MCP_UPSTREAM_CONCURRENCY', () => {
  // one shared limit for every client; its size is observed by filling it
  const capOf = async (env: Record<string, string | undefined>) => {
    const f = fixture();
    const limits: unknown[] = [];
    const { createClient } = await import('../stralfors/index.ts');
    const s = await start({ ...base, ...env }, {
      readFile: (p) => (p === 'x' ? f.text() : readFileSync(p, 'utf8')), stderr: { write: () => true }, audit: sink().audit, now: () => T, onSignal: () => undefined,
      clientFactory: (o) => (limits.push(o.upstreamLimit), createClient(o)),
    });
    started.push(s);
    const l = limits[0] as { tryAcquire(): boolean };
    expect(limits.every((x) => x === l)).toBe(true);
    let n = 0;
    while (l.tryAcquire() && n < 2000) n++;
    return n;
  };
  it('defaults to 16 and passes a set value on', async () => {
    expect(await capOf({})).toBe(16);
    expect(await capOf({ MCP_UPSTREAM_CONCURRENCY: '1000' })).toBe(1000);
    expect(await capOf({ MCP_UPSTREAM_CONCURRENCY: '1' })).toBe(1);
  });
  it.each(['0', '1001', 'abc', '-1', '1.5', ''])('refuses %j', async (v) => {
    await expect(go({ MCP_UPSTREAM_CONCURRENCY: v })).rejects.toThrow('MCP_UPSTREAM_CONCURRENCY is invalid');
  });
});

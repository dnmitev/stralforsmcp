// R-35: write-scope claims come from the profiles' real Stralfors tokens; prefetched at startup only when writes are allowed.
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { start, type Started } from './main.ts';
import * as mcp from './mcp.ts';
import { sink } from '../../test/helpers/server.ts';
import { fixture, T } from '../../test/helpers/token-list.ts';
import { makeEnv } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import type { CreateClientOptions, StralforsClient } from '../stralfors/index.ts';

vi.mock('./mcp.ts', async (orig) => {
  const actual = await orig<typeof import('./mcp.ts')>();
  return { ...actual, buildMcp: vi.fn(actual.buildMcp) };
});
let pki: Pki;
let base: Record<string, string>;
beforeAll(() => {
  pki = generatePki();
  base = { MCP_TOKEN_LIST_FILE: 'x', MCP_HOSTNAMES: '127.0.0.1', MCP_PORT: '0', MCP_METRICS_PORT: '0', MCP_METRICS_HOST: '127.0.0.1', MCP_LISTEN_HOST: '127.0.0.1', MCP_HEARTBEAT_S: '0', ...makeEnv(pki).env };
});
afterAll(() => pki.cleanup());
const started: Started[] = [];
afterEach(async () => {
  vi.mocked(mcp.buildMcp).mockClear();
  await Promise.all(started.splice(0).map((s) => s.close()));
});

type Fake = { gets: number; peeks: number };
const client = (f: Fake, scopes: string[] | 'fail') => ({
  close: async () => undefined, certExpiresAt: () => T + 86_400_000, healthV1: async () => ({ status: 'UP' }),
  token: {
    get: async () => { f.gets++; if (scopes === 'fail') throw new Error('token endpoint down'); held = scopes; return {}; },
    peek: () => { f.peeks++; return held === undefined ? undefined : { hasScope: (s: string) => held!.includes(s) }; },
  },
}) as unknown as StralforsClient;
let held: string[] | undefined;
const boot = async (env: Record<string, string>, scopes: string[] | 'fail') => {
  held = undefined;
  const f: Fake = { gets: 0, peeks: 0 };
  const warns: string[] = [];
  const s = await start({ ...base, ...env }, {
    readFile: (p) => (p === 'x' ? fixture().text() : readFileSync(p, 'utf8')),
    stderr: { write: (l: string) => (warns.push(String(l)), true) }, audit: sink().audit, now: () => T, onSignal: () => undefined,
    clientFactory: (_o: CreateClientOptions) => client(f, scopes),
  });
  started.push(s);
  const claimsFor = (vi.mocked(mcp.buildMcp).mock.calls.at(-1)![0] as { claimsFor?: (a: unknown) => { hasScope(s: string): boolean } | undefined }).claimsFor!;
  return { f, warns, claimsFor };
};

describe('claims from profile tokens (R-35)', () => {
  it('send_invoice is registered as a write tool (06-02); the policy decides visibility per caller', async () => {
    await boot({ STRALFORS_ALLOW_WRITE: 'true' }, ['apiomni.write']);
    const tools = (vi.mocked(mcp.buildMcp).mock.calls.at(-1)![0] as { tools: { spec: { name: string; access: string } }[] }).tools;
    expect(tools.find((t) => t.spec.name === 'send_invoice')?.spec.access).toBe('write');
  });
  it('writes allowed: each profile token is fetched once at startup and its scopes answer hasScope', async () => {
    const { f, claimsFor } = await boot({ STRALFORS_ALLOW_WRITE: 'true' }, ['apiomni.read', 'apiomni.write']);
    expect(f.gets).toBe(1); // one profile in the test env
    const c = claimsFor(undefined)!;
    expect(c.hasScope('apiomni.write')).toBe(true);
    expect(c.hasScope('sms.write')).toBe(false);
    expect(f.gets).toBe(1); // claims never fetch
  });
  it('a token without the write scope: hasScope false', async () => {
    const { claimsFor } = await boot({ STRALFORS_ALLOW_WRITE: 'true' }, ['apiomni.read']);
    expect(claimsFor(undefined)!.hasScope('apiomni.write')).toBe(false);
  });
  it('a failed prefetch logs a fixed warning, the server starts, and claims hold nothing', async () => {
    const { f, warns, claimsFor } = await boot({ STRALFORS_ALLOW_WRITE: 'true' }, 'fail');
    expect(f.gets).toBe(1);
    expect(warns.join('')).toContain('credentials.token_prefetch_failed');
    expect(warns.join('')).not.toContain('token endpoint down');
    expect(claimsFor(undefined)!.hasScope('apiomni.write')).toBe(false);
  });
  it('writes not allowed: no startup fetch; claims stay empty until some call fetched a token', async () => {
    const { f, claimsFor } = await boot({}, ['apiomni.write']);
    expect(f.gets).toBe(0);
    expect(claimsFor(undefined)!.hasScope('apiomni.write')).toBe(false);
  });
});

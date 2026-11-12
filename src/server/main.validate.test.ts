// L2 wiring: start() hands the config's prodValidateEnabled to the registry. L3: the current tool set still starts without claims.
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
const seen = () => vi.mocked(mcp.buildMcp).mock.calls[0]![0] as unknown as { prodValidateEnabled?: boolean };

describe('start passes prodValidateEnabled to the registry', () => {
  it.each([
    ['prod, set true', { STRALFORS_ENV: 'prod', STRALFORS_PROD_VALIDATE_ENABLED: 'true' }, true],
    ['prod, unset', { STRALFORS_ENV: 'prod' }, false],
    ['prod, set false', { STRALFORS_ENV: 'prod', STRALFORS_PROD_VALIDATE_ENABLED: 'false' }, false],
    ['test, set true', { STRALFORS_ENV: 'test', STRALFORS_PROD_VALIDATE_ENABLED: 'true' }, true],
  ] as const)('%s', async (_n, env, expected) => {
    await go(env);
    expect(seen().prodValidateEnabled).toBe(expected);
  });
});

describe('claims guard does not stop the current tool set', () => {
  it('whoami + list_channels (read, no scope) start without claims', async () => {
    const s = await go({});
    expect(s.port).toBeGreaterThan(0);
  });
});

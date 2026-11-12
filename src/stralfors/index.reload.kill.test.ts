// Mutation-hardening for the 02-06 reload path in index.ts: agent options, optional passphrase, empty passphrase file.
import { rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.ts';
import { createAgent, createClient } from './index.ts';
import { makeEnv, memoryLogger } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

let pki: Pki;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());

function build(noPassphrase = false) {
  const f = makeEnv(pki, noPassphrase
    ? { certText: pki.server.cert, keyText: pki.server.key, extra: { STRALFORS_PROFILE_A_KEY_PASSPHRASE_FILE: undefined as unknown as string } }
    : {});
  const config = loadConfig(f.env);
  const factory = vi.fn((p: Parameters<typeof createAgent>[0], o?: Parameters<typeof createAgent>[1]) => createAgent(p, o));
  const mem = memoryLogger();
  const client = createClient({ config, profileId: 'a', ca: pki.ca, logger: mem.logger, createAgent: factory as typeof createAgent, setTimer: () => 0, clearTimer: () => {} });
  const failures = () => mem.lines().filter((l) => l['msg'] === 'credentials.reload_failed');
  return { client, factory, failures, env: f.env };
}

describe('reload path hardening', () => {
  it('the trust anchor is passed to every agent, first and rotated', async () => {
    const c = build();
    expect(c.factory.mock.calls[0]![1]).toEqual({ ca: pki.ca });
    writeFileSync(c.env['STRALFORS_PROFILE_A_CERT_FILE']!, pki.foreignClient.cert);
    writeFileSync(c.env['STRALFORS_PROFILE_A_KEY_FILE']!, pki.foreignClient.key);
    c.client.reloadCredentials();
    expect(c.factory).toHaveBeenCalledTimes(2);
    expect(c.factory.mock.calls[1]![1]).toEqual({ ca: pki.ca });
    await c.client.close();
  });

  it('a profile without a passphrase file builds, and an unchanged tick is silent', async () => {
    const c = build(true);
    c.client.reloadCredentials();
    expect(c.factory).toHaveBeenCalledTimes(1);
    expect(c.failures()).toEqual([]);
    await c.client.close();
  });

  it('an emptied passphrase file is an empty failure, not a key failure', async () => {
    const c = build();
    writeFileSync(c.env['STRALFORS_PROFILE_A_KEY_PASSPHRASE_FILE']!, '\n');
    c.client.reloadCredentials();
    expect(c.failures().map((l) => l['kind'])).toEqual(['empty']);
    expect(c.factory).toHaveBeenCalledTimes(1);
    await c.client.close();
  });

  it('a missing passphrase file is a read failure', async () => {
    const c = build();
    rmSync(c.env['STRALFORS_PROFILE_A_KEY_PASSPHRASE_FILE']!);
    c.client.reloadCredentials();
    expect(c.failures().map((l) => l['kind'])).toEqual(['read']);
    await c.client.close();
  });
});

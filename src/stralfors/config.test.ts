/*
 * R1 config. API under test (src/stralfors/config.ts):
 *   loadConfig(env: Record<string, string | undefined>, fs?: { readFileSync(path, 'utf8'): string }): Config
 *   Config { env: 'test'|'prod'; baseUrl: string; allowWrite: boolean; prodValidateEnabled: boolean;
 *            timeoutMs: number; tokenRefreshMarginS: number; maxBodyBytes: number;
 *            profiles: Record<string, Profile> }
 *   Profile { id: string; country: string; actionIds: { label?: string; id: string }[];
 *             clientId; clientSecret; cert; key: string; passphrase?: string }
 *   - Secret props (clientId, clientSecret, cert, key, passphrase) are readable by name but NON-enumerable;
 *     Config/Profile have toString/toJSON/inspect.custom that never reveal them.
 *   - Env additions beyond R1: STRALFORS_PROD_VALIDATE_ENABLED=true|false (default false).
 *   - File contents are trimmed (trailing newline) before use.
 *   - Errors: ConfigError from errors.ts; message names the env variable (or label), never a value.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { ConfigError } from './errors.ts';
import { makeEnv } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

let pki: Pki;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());

const two = () => {
  const a = makeEnv(pki, { id: 'a' });
  const b = makeEnv(pki, { id: 'test-x' });
  const g1 = randomUUID();
  const g2 = randomUUID();
  const env: Record<string, string | undefined> = {
    ...a.env, ...b.env, STRALFORS_PROFILES: 'a,test-x',
    STRALFORS_PROFILE_TEST_X_ACTION_IDS: `billing:${g1},${g2}`,
  };
  return { a, b, env, g1, g2 };
};
const throwsConfig = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).kind).toBe('config');
    return e as ConfigError;
  }
  throw new Error('expected ConfigError');
};

describe('R1 configuration loading', () => {
  it('valid test config with two profiles', () => {
    const { a, b, env, g1, g2 } = two();
    const config = loadConfig(env);
    expect(config.env).toBe('test');
    expect(config.baseUrl).toBe('https://test.api.stralfors.com');
    expect(Object.keys(config.profiles)).toEqual(['a', 'test-x']);
    const pa = config.profiles['a']!;
    const pb = config.profiles['test-x']!;
    expect(pa.country).toBe('SE');
    expect(pa.actionIds).toEqual([]);
    expect(pb.actionIds).toEqual([{ label: 'billing', id: g1 }, { id: g2 }]);
    expect(pa.clientId).toBe(a.clientId);
    expect(pa.clientSecret).toBe(a.clientSecret);
    expect(pa.passphrase).toBe(a.passphrase);
    expect(pa.cert).toContain('BEGIN CERTIFICATE');
    expect(pa.key).toContain('ENCRYPTED PRIVATE KEY');
    expect(pb.clientSecret).toBe(b.clientSecret);
    for (const text of [String(config), JSON.stringify(config), inspect(config, { depth: null }), JSON.stringify(pa), inspect(pa, { depth: null })]) {
      for (const secret of [a.clientId, a.clientSecret, a.passphrase, b.clientSecret, pki.client.key.split('\n')[1]!]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('defaults and overrides', () => {
    const { env } = two();
    const d = loadConfig(env);
    expect([d.timeoutMs, d.tokenRefreshMarginS, d.maxBodyBytes, d.allowWrite, d.prodValidateEnabled]).toEqual([30000, 300, 8388608, false, false]);
    const o = loadConfig({
      ...env, STRALFORS_TIMEOUT_MS: '200', STRALFORS_TOKEN_REFRESH_MARGIN_S: '60', STRALFORS_MAX_BODY_BYTES: '1024',
      STRALFORS_ALLOW_WRITE: 'true', STRALFORS_PROD_VALIDATE_ENABLED: 'true',
    });
    expect([o.timeoutMs, o.tokenRefreshMarginS, o.maxBodyBytes, o.allowWrite, o.prodValidateEnabled]).toEqual([200, 60, 1024, true, true]);
    const prod = loadConfig({ ...env, STRALFORS_ENV: 'prod' });
    expect(prod.env).toBe('prod');
    expect(prod.baseUrl).toBe('https://api.stralfors.com');
  });

  it('missing required variable', () => {
    const { a, env } = two();
    delete env['STRALFORS_PROFILE_A_CERT_FILE'];
    const e = throwsConfig(() => loadConfig(env));
    expect(e.message).toContain('STRALFORS_PROFILE_A_CERT_FILE');
    expect(e.message).not.toContain(a.clientSecret);
    expect(e.message).not.toContain(a.clientId);
    for (const name of ['STRALFORS_ENV', 'STRALFORS_PROFILES', 'STRALFORS_PROFILE_A_COUNTRY']) {
      const copy: Record<string, string | undefined> = { ...two().env };
      delete copy[name];
      expect(throwsConfig(() => loadConfig(copy)).message).toContain(name);
    }
  });

  it('unreadable or empty secret file', () => {
    const { a, env } = two();
    writeFileSync(env['STRALFORS_PROFILE_A_CLIENT_SECRET_FILE']!, '');
    const e = throwsConfig(() => loadConfig(env));
    expect(e.message).toContain('STRALFORS_PROFILE_A_CLIENT_SECRET_FILE');
    expect(e.message).not.toContain(a.clientId);
    const gone = two().env;
    gone['STRALFORS_PROFILE_A_CLIENT_ID_FILE'] = `${pki.dir}/does-not-exist`;
    expect(throwsConfig(() => loadConfig(gone)).message).toContain('STRALFORS_PROFILE_A_CLIENT_ID_FILE');
  });

  it('agreement ids must be uuids', () => {
    const { env } = two();
    env['STRALFORS_PROFILE_A_ACTION_IDS'] = 'billing:not-a-uuid';
    const e = throwsConfig(() => loadConfig(env));
    expect(e.message).toContain('ACTION_IDS');
    expect(e.message).toContain('billing');
    expect(e.message).not.toContain('not-a-uuid');
  });

  it('prod refuses write', () => {
    const { env } = two();
    const e = throwsConfig(() => loadConfig({ ...env, STRALFORS_ENV: 'prod', STRALFORS_ALLOW_WRITE: 'true' }));
    expect(e.message).toContain('write is never allowed in prod');
  });

  it('unknown env', () => {
    const { env } = two();
    const e = throwsConfig(() => loadConfig({ ...env, STRALFORS_ENV: 'staging' }));
    expect(e.message).toContain('test');
    expect(e.message).toContain('prod');
  });
});

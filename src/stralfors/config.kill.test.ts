// Mutation-hardening for config.ts: opacity labels, secret non-enumerability, env parsing, action id syntax, prod-write refusal.
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError } from './errors.ts';
import { loadConfig } from './config.ts';
import { makeEnv } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

let pki: Pki;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());

const UUID = '0b6f7a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const load = (extra: Record<string, string | undefined> = {}) => loadConfig(makeEnv(pki, { extra }).env);
const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e as ConfigError;
  }
  throw new Error('did not throw');
};
const A = 'STRALFORS_PROFILE_A';

describe('opacity', () => {
  it('Profile and Config reveal only their label', () => {
    const c = load();
    const p = c.profiles['a']!;
    for (const [o, label] of [[p, 'Profile(a)'], [c, 'Config(test)']] as const) {
      expect(String(o)).toBe(label);
      expect(JSON.stringify(o)).toBe(JSON.stringify(label));
      expect(inspect(o)).toBe(label);
      expect(`${inspect(o, { depth: null })}`).toBe(label);
    }
  });

  it('own property names are exactly the data fields plus the three label hooks', () => {
    const c = load();
    expect(Object.getOwnPropertyNames(c).sort()).toEqual(
      ['allowWrite', 'baseUrl', 'certReloadS', 'env', 'maxBodyBytes', 'profiles', 'prodValidateEnabled', 'timeoutMs', 'toJSON', 'toString', 'tokenRefreshMarginS'].sort(),
    );
  });

  it('prod label', () => {
    expect(String(load({ STRALFORS_ENV: 'prod' }))).toBe('Config(prod)');
  });

  it('secrets are readable but not enumerable; other fields stay enumerable', () => {
    const p = load().profiles['a']!;
    const secrets = ['clientId', 'clientSecret', 'cert', 'key', 'passphrase'] as const;
    for (const k of secrets) {
      expect(typeof p[k]).toBe('string');
      expect(Object.keys(p)).not.toContain(k);
      expect(Object.keys({ ...p })).not.toContain(k);
    }
    expect(Object.keys(p)).toEqual(expect.arrayContaining(['id', 'country', 'agreements']));
    expect(Object.keys(p)).not.toContain('actionIds');
  });

  it('an absent passphrase is not defined as a property', () => {
    const p = load({ [`${A}_KEY_PASSPHRASE_FILE`]: undefined }).profiles['a']!;
    expect('passphrase' in p).toBe(false);
  });
});

describe('files', () => {
  const stub = (content: string | (() => string)) => ({ readFileSync: () => (typeof content === 'function' ? content() : content) });

  it('file content is trimmed', () => {
    const p = loadConfig(makeEnv(pki).env, stub('  value\n')).profiles['a']!;
    expect([p.clientId, p.clientSecret, p.passphrase]).toEqual(['value', 'value', 'value']);
  });

  it('unreadable file: named, without the path or the cause', () => {
    const e = err(() => loadConfig(makeEnv(pki).env, stub(() => { throw new Error('EACCES /secret/path'); })));
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.message).toBe(`cannot read file of ${A}_CLIENT_ID_FILE`);
  });

  it('empty file and missing variable', () => {
    expect(err(() => loadConfig(makeEnv(pki).env, stub(' \n'))).message).toBe(`file of ${A}_CLIENT_ID_FILE is empty`);
    expect(err(() => load({ [`${A}_CLIENT_SECRET_FILE`]: undefined })).message).toBe(`missing ${A}_CLIENT_SECRET_FILE`);
  });
});

describe('numeric and boolean env', () => {
  it.each([['0'], ['-1'], ['1.5'], ['abc'], ['5x'], ['x5'], [''], [' 5']])('STRALFORS_TIMEOUT_MS=%j is rejected', (v) => {
    expect(err(() => load({ STRALFORS_TIMEOUT_MS: v })).message).toBe('STRALFORS_TIMEOUT_MS must be a positive integer');
  });

  it('1 is the smallest accepted value; defaults apply when unset', () => {
    expect(load({ STRALFORS_TIMEOUT_MS: '1' }).timeoutMs).toBe(1);
    const c = load();
    expect([c.timeoutMs, c.tokenRefreshMarginS, c.maxBodyBytes]).toEqual([30000, 300, 8388608]);
  });

  it.each([['STRALFORS_ALLOW_WRITE'], ['STRALFORS_PROD_VALIDATE_ENABLED']])('%s accepts only true/false', (name) => {
    for (const v of ['yes', 'TRUE', '1', '']) expect(err(() => load({ [name]: v })).message).toBe(`${name} must be true or false`);
    expect(() => load({ [name]: 'false' })).not.toThrow();
  });

  it('write allowed in test, never in prod', () => {
    expect(load({ STRALFORS_ALLOW_WRITE: 'true' }).allowWrite).toBe(true);
    expect(load().allowWrite).toBe(false);
    expect(err(() => load({ STRALFORS_ENV: 'prod', STRALFORS_ALLOW_WRITE: 'true' })).message).toBe('write is never allowed in prod (STRALFORS_ALLOW_WRITE)');
    expect(load({ STRALFORS_ENV: 'prod' }).baseUrl).toBe('https://api.stralfors.com');
    expect(load().baseUrl).toBe('https://test.api.stralfors.com');
    expect(err(() => load({ STRALFORS_ENV: 'dev' })).message).toBe('STRALFORS_ENV must be test or prod');
  });
});

describe('profiles and agreement ids', () => {
  it('profile list is trimmed and empty entries are skipped', () => {
    expect(Object.keys(load({ STRALFORS_PROFILES: ' a , ' }).profiles)).toEqual(['a']);
  });

  it('labelled and unlabelled ids, whitespace tolerated, blank entries skipped', () => {
    const ids = load({ [`${A}_ACTION_IDS`]: ` main : ${UUID.toUpperCase()} , ${UUID} , , ` }).profiles['a']!.agreements;
    expect(ids).toEqual([{ label: 'main', id: UUID.toUpperCase() }, { id: UUID }]);
  });

  it('a whitespace-only or empty label counts as absent', () => {
    expect(load({ [`${A}_ACTION_IDS`]: `  :${UUID}` }).profiles['a']!.agreements).toEqual([{ id: UUID }]);
    expect(load({ [`${A}_ACTION_IDS`]: `:${UUID}` }).profiles['a']!.agreements).toEqual([{ id: UUID }]);
  });

  it('invalid id: error names the label or the 1-based entry, never the value', () => {
    const msg = (v: string) => err(() => load({ [`${A}_ACTION_IDS`]: v })).message;
    expect(msg('lbl:not-a-uuid')).toBe(`${A}_ACTION_IDS: invalid agreement id (label lbl)`);
    expect(msg('nope')).toBe(`${A}_ACTION_IDS: invalid agreement id (entry 1)`);
    expect(msg(`${UUID}, nope`)).toBe(`${A}_ACTION_IDS: invalid agreement id (entry 2)`);
  });

  it('UUID is anchored at both ends', () => {
    for (const v of [`x${UUID}`, `${UUID}x`, `${UUID}-0`, UUID.slice(1)]) expect(() => load({ [`${A}_ACTION_IDS`]: v })).toThrow(ConfigError);
  });
});

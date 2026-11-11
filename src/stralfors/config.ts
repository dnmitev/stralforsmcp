import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { ConfigError } from './errors.ts';

export interface Profile {
  id: string;
  country: string;
  agreements: { label?: string; id: string }[];
  clientId: string;
  clientSecret: string;
  cert: string;
  key: string;
  passphrase?: string;
}
export interface Config {
  env: 'test' | 'prod';
  baseUrl: string;
  allowWrite: boolean;
  prodValidateEnabled: boolean;
  timeoutMs: number;
  tokenRefreshMarginS: number;
  maxBodyBytes: number;
  profiles: Record<string, Profile>;
}

const BASE = { test: 'https://test.api.stralfors.com', prod: 'https://api.stralfors.com' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hides everything from toString / JSON / inspect; secrets are additionally non-enumerable. */
const opaque = <T extends object>(o: T, label: string, secrets: string[] = []): T =>
  Object.defineProperties(o, {
    toString: { value: () => label },
    toJSON: { value: () => label },
    [inspect.custom]: { value: () => label },
    ...Object.fromEntries(secrets.map((k) => [k, { ...Object.getOwnPropertyDescriptor(o, k), enumerable: false }])),
  });

export function loadConfig(
  vars: Record<string, string | undefined>,
  fs: { readFileSync(path: string, enc: 'utf8'): string } = { readFileSync },
): Config {
  const need = (name: string) => {
    const v = vars[name];
    if (!v) throw new ConfigError(`missing ${name}`);
    return v;
  };
  const file = (name: string) => {
    let text: string;
    try {
      text = fs.readFileSync(need(name), 'utf8').trim();
    } catch (e) {
      throw e instanceof ConfigError ? e : new ConfigError(`cannot read file of ${name}`);
    }
    if (!text) throw new ConfigError(`file of ${name} is empty`);
    return text;
  };
  const num = (name: string, def: number) => {
    const v = vars[name];
    if (v === undefined) return def;
    if (!/^\d+$/.test(v) || Number(v) < 1) throw new ConfigError(`${name} must be a positive integer`);
    return Number(v);
  };
  const bool = (name: string) => {
    const v = vars[name] ?? 'false';
    if (v !== 'true' && v !== 'false') throw new ConfigError(`${name} must be true or false`);
    return v === 'true';
  };

  const mode = need('STRALFORS_ENV');
  if (mode !== 'test' && mode !== 'prod') throw new ConfigError('STRALFORS_ENV must be test or prod');
  const allowWrite = bool('STRALFORS_ALLOW_WRITE');
  if (mode === 'prod' && allowWrite) throw new ConfigError('write is never allowed in prod (STRALFORS_ALLOW_WRITE)');

  const profiles: Record<string, Profile> = {};
  for (const id of need('STRALFORS_PROFILES').split(',').map((s) => s.trim()).filter(Boolean)) {
    const P = `STRALFORS_PROFILE_${id.toUpperCase().replaceAll('-', '_')}`;
    const actionName = `${P}_ACTION_IDS`;
    const agreements = (vars[actionName] ?? '').split(',').map((e) => e.trim()).filter(Boolean).map((entry, i) => {
      const c = entry.indexOf(':');
      // Stryker disable next-line EqualityOperator: c === 0 gives label '' (original) or undefined (mutant); both mean no label
      const label = c < 0 ? undefined : entry.slice(0, c).trim();
      const id = entry.slice(c + 1).trim();
      if (!UUID.test(id)) throw new ConfigError(`${actionName}: invalid agreement id (${label ? `label ${label}` : `entry ${i + 1}`})`);
      return label ? { label, id } : { id };
    });
    const profile: Profile = {
      id, country: need(`${P}_COUNTRY`), agreements,
      clientId: file(`${P}_CLIENT_ID_FILE`), clientSecret: file(`${P}_CLIENT_SECRET_FILE`),
      cert: file(`${P}_CERT_FILE`), key: file(`${P}_KEY_FILE`),
    };
    if (vars[`${P}_KEY_PASSPHRASE_FILE`]) profile.passphrase = file(`${P}_KEY_PASSPHRASE_FILE`);
    profiles[id] = opaque(profile, `Profile(${id})`, ['clientId', 'clientSecret', 'cert', 'key', 'passphrase'].filter((k) => k in profile));
  }

  return opaque({
    env: mode, baseUrl: BASE[mode], allowWrite, prodValidateEnabled: bool('STRALFORS_PROD_VALIDATE_ENABLED'),
    timeoutMs: num('STRALFORS_TIMEOUT_MS', 30000), tokenRefreshMarginS: num('STRALFORS_TOKEN_REFRESH_MARGIN_S', 300),
    maxBodyBytes: num('STRALFORS_MAX_BODY_BYTES', 8388608), profiles,
  }, `Config(${mode})`);
}

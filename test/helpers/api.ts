// Shared fakes for the client tests: JWT builder, fake token+API server, profile env/files,
// in-memory pino sink and a client factory. Imports the client under test from src/stralfors/index.ts.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type CreateClientOptions } from '../../src/stralfors/index.ts';
import { loadConfig } from '../../src/stralfors/config.ts';
import { createLogger } from '../../src/stralfors/log.ts';
import { startServer, type Handler, type LoggedRequest, type Pki, type TestServer } from './mtls.ts';

export const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');
export const canary = (label: string) => `CANARY_${label}_${randomBytes(6).toString('hex')}`;

/** Unsigned-looking JWT; the client never verifies the signature. */
export function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.${b64url(randomBytes(8))}`;
}

export interface FakeApiOpts {
  pki: Pki;
  serverCert?: 'trusted' | 'selfSigned';
  /** clock the issued JWTs are relative to (ms); default Date.now() */
  nowMs?: number;
  /** extra/overriding JWT claims */
  claims?: Record<string, unknown>;
  expiresIn?: number;
  /** return this instead of a JWT (opaque token case) */
  opaqueToken?: string;
  tokenDelayMs?: number;
  /** replaces the whole token endpoint */
  token?: Handler;
  /** every non-token request */
  api?: Handler;
}
export interface FakeApi extends TestServer {
  tokenRequests: LoggedRequest[];
  apiRequests: LoggedRequest[];
  /** access tokens issued so far, in order */
  issued: string[];
}

export const json = (res: import('node:http').ServerResponse, status: number, body: unknown, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

export async function startFakeApi(o: FakeApiOpts): Promise<FakeApi> {
  const issued: string[] = [];
  const handler: Handler = async (req, res, entry) => {
    if (req.url === '/v1/oidc/token') {
      if (o.token) return o.token(req, res, entry);
      if (o.tokenDelayMs) await new Promise((r) => setTimeout(r, o.tokenDelayMs));
      const iat = Math.floor((o.nowMs ?? Date.now()) / 1000);
      const exp = iat + (o.expiresIn ?? 3600);
      const access =
        o.opaqueToken ??
        makeJwt({
          scope: ['apiomni.read', 'openid'], iat, nbf: iat, exp, aud: ['https://h.example.invalid'],
          iss: 'https://iss.example.invalid', sub: 'sub-x', jti: `jti-${issued.length}-${randomBytes(4).toString('hex')}`,
          customer: 'https://c.example.invalid/customers/x/SE', ...o.claims,
        });
      issued.push(access);
      return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: o.expiresIn ?? 3600 });
    }
    if (o.api) return o.api(req, res, entry);
    return json(res, 404, 'No Mapping Rule matched', 'text/plain; charset=us-ascii');
  };
  const srv = await startServer(handler, { pki: o.pki, serverCert: o.serverCert });
  return {
    ...srv,
    issued,
    get tokenRequests() { return srv.requests.filter((r) => r.url === '/v1/oidc/token'); },
    get apiRequests() { return srv.requests.filter((r) => r.url !== '/v1/oidc/token'); },
  };
}

export interface EnvOpts {
  /** profile id (lower-case, may contain '-'); default 'a' */
  id?: string;
  who?: 'client' | 'foreign';
  clientId?: string;
  clientSecret?: string;
  passphrase?: string;
  /** replaces the cert / key PEM text written to the files */
  certText?: string;
  keyText?: string;
  /** extra/overriding env vars; undefined removes */
  extra?: Record<string, string | undefined>;
}
export interface ProfileFiles {
  env: Record<string, string>;
  dir: string;
  clientId: string;
  clientSecret: string;
  passphrase: string;
}

/** Writes one profile's secret files into a fresh dir under pki.dir and returns an env object (never process.env). */
export function makeEnv(pki: Pki, o: EnvOpts = {}): ProfileFiles {
  const dir = mkdtempSync(join(pki.dir, 'profile-'));
  const id = o.id ?? 'a';
  const P = `STRALFORS_PROFILE_${id.toUpperCase().replaceAll('-', '_')}`;
  const pair = o.who === 'foreign' ? pki.foreignClient : pki.client;
  const clientId = o.clientId ?? `client-${randomBytes(4).toString('hex')}`;
  const clientSecret = o.clientSecret ?? `secret-${randomBytes(6).toString('hex')}`;
  const passphrase = o.passphrase ?? pair.passphrase;
  const files: Record<string, string> = {
    CLIENT_ID_FILE: clientId, CLIENT_SECRET_FILE: clientSecret, CERT_FILE: o.certText ?? pair.cert,
    KEY_FILE: o.keyText ?? pair.key, KEY_PASSPHRASE_FILE: passphrase,
  };
  const env: Record<string, string> = { STRALFORS_ENV: 'test', STRALFORS_PROFILES: id, [`${P}_COUNTRY`]: 'SE' };
  for (const [k, v] of Object.entries(files)) {
    const f = join(dir, k.toLowerCase());
    writeFileSync(f, v);
    env[`${P}_${k}`] = f;
  }
  for (const [k, v] of Object.entries(o.extra ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return { env, dir, clientId, clientSecret, passphrase };
}

/** In-memory pino destination; `lines()` parses every JSON line written so far. */
export function memoryLogger(level = 'trace') {
  const chunks: string[] = [];
  const logger = createLogger({ level, destination: { write: (s: string) => void chunks.push(s) } });
  return {
    logger,
    text: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

export interface TestClientOpts extends EnvOpts, Partial<Pick<CreateClientOptions, 'logger' | 'onBlocked' | 'now'>> {}

/** Config from a real temp-file env + client pointed at `srv` with the runtime CA. */
export function testClient(pki: Pki, srv: TestServer, o: TestClientOpts = {}) {
  const files = makeEnv(pki, o);
  const config = loadConfig(files.env);
  const client = createClient({
    config, profileId: o.id ?? 'a', ca: pki.ca, baseUrl: srv.url,
    logger: o.logger, onBlocked: o.onBlocked, now: o.now,
  });
  return { client, config, files };
}

export const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/stralfors/${name}`, import.meta.url), 'utf8');
export const fixtureJson = (name: string): unknown => JSON.parse(fixture(name));

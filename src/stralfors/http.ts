import { createPrivateKey } from 'node:crypto';
import { Agent, request, type Dispatcher } from 'undici';
import type { Profile } from './config.ts';
import { ResponseTooLargeError, StralforsError, TimeoutError, TlsError, UpstreamError } from './errors.ts';

/** One keep-alive agent per profile. The key is checked eagerly so a wrong passphrase fails at startup, not at the first call. */
export function createAgent(profile: Profile, opts: { ca?: string } = {}): Dispatcher {
  try {
    createPrivateKey({ key: profile.key, passphrase: profile.passphrase });
  } catch {
    throw new TlsError(`cannot load client key of profile ${profile.id}`, { profile: profile.id });
  }
  return new Agent({
    connections: 8,
    connect: { cert: profile.cert, key: profile.key, passphrase: profile.passphrase, ca: opts.ca, rejectUnauthorized: true },
  });
}

const BASE = '/rest/outputmanagement/apiomni';
const PROD_READS = new Set(['/v2/apiinfo', '/v1/manage/health', '/v2/invoices/channels', '/v2/invoices/templates', '/v2/invoices/rules', '/v2/invoices/document'].map((p) => BASE + p));

export function isAllowed(policy: { env: 'test' | 'prod'; allowWrite: boolean; prodValidateEnabled: boolean }, method: string, pathWithQuery: string): boolean {
  const u = new URL(pathWithQuery, 'http://x');
  const path = u.pathname;
  const m = method.toUpperCase();
  const dryRun = m === 'PUT' && path === `${BASE}/v2/invoices/validate` && u.searchParams.getAll('test').join() === 'true';
  if (policy.env === 'prod') return (m === 'GET' && PROD_READS.has(path)) || (dryRun && policy.prodValidateEnabled);
  return m === 'GET' || dryRun || policy.allowWrite; // fail closed: any other method needs allowWrite
}

export interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  bytes: number;
}

const TLS_CODE = /^(ERR_SSL|ERR_TLS|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|CERT_)/;
// ponytail: TLS 1.3 reports a rejected client cert as a reset/closed socket, so those count as TLS until the agent has had one HTTP response;
// afterwards they are keep-alive races (upstream). A reset on a first request that is not TLS is still misreported.
const RESET_CODE = /^(ECONNRESET|UND_ERR_SOCKET)/;
const proven = new WeakSet<Dispatcher>();

/** One request with an overall timeout and a body cap enforced while streaming. Throws StralforsError only. */
export async function send(
  agent: Dispatcher,
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number },
): Promise<Raw> {
  const signal = AbortSignal.timeout(init.timeoutMs);
  try {
    const res = await request(url, { dispatcher: agent, method: init.method as Dispatcher.HttpMethod, headers: init.headers, body: init.body, signal });
    proven.add(agent); // any HTTP response proves the handshake
    if (Number([res.headers['content-length']].flat()[0]) > init.maxBytes) {
      res.body.destroy();
      throw new ResponseTooLargeError(`response exceeds ${init.maxBytes} bytes`);
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of res.body) {
      bytes += (chunk as Buffer).length;
      if (bytes > init.maxBytes) {
        // Stryker disable next-line CallExpression: leaving the for-await by a throw destroys the stream anyway; the call only makes that explicit
        res.body.destroy();
        throw new ResponseTooLargeError(`response exceeds ${init.maxBytes} bytes`);
      }
      chunks.push(chunk as Buffer);
    }
    return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), bytes };
  } catch (e) {
    if (e instanceof StralforsError) throw e;
    if (signal.aborted) throw new TimeoutError(`no complete response within ${init.timeoutMs} ms`);
    const err = e as { code?: string; cause?: { code?: string } };
    const code = err.code ?? err.cause?.code ?? '';
    if (TLS_CODE.test(code) || (RESET_CODE.test(code) && !proven.has(agent))) throw new TlsError(`TLS failure (${code})`);
    throw new UpstreamError(`network error (${code})`);
  }
}

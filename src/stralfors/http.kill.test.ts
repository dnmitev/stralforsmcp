// Mutation-hardening for http.ts: guard matrix (pure), error classification and size/timeout edges through a stubbed undici.request.
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dispatcher } from 'undici';
import type { Profile } from './config.ts';
import { ResponseTooLargeError, TimeoutError, TlsError, UpstreamError } from './errors.ts';

const request = vi.hoisted(() => vi.fn());
vi.mock('undici', async (orig) => ({ ...(await orig<typeof import('undici')>()), request }));
const { createAgent, isAllowed, send } = await import('./http.ts');

const B = '/rest/outputmanagement/apiomni';
const VALIDATE = `${B}/v2/invoices/validate`;
const policy = (env: 'test' | 'prod', allowWrite = false, prodValidateEnabled = false) => ({ env, allowWrite, prodValidateEnabled });

describe('R9 guard matrix gaps', () => {
  it('test env: only GET and the dry-run validate are free; everything else needs allowWrite', () => {
    const p = policy('test');
    expect(isAllowed(p, 'GET', `${B}/v2/anything`)).toBe(true);
    expect(isAllowed(p, 'PUT', `${VALIDATE}?test=true`)).toBe(true);
    expect(isAllowed(p, 'PUT', `${B}/v2/invoices/other`)).toBe(false);
    expect(isAllowed(p, 'PUT', `${B}/v2/invoices/other?test=true`)).toBe(false);
    expect(isAllowed(p, 'PUT', VALIDATE)).toBe(false);
    expect(isAllowed(p, 'PUT', `${VALIDATE}?test=false`)).toBe(false);
    expect(isAllowed(p, 'POST', `${VALIDATE}?test=true`)).toBe(false);
    expect(isAllowed(p, 'DELETE', `${B}/v2/x`)).toBe(false);
    expect(isAllowed(policy('test', true), 'DELETE', `${B}/v2/x`)).toBe(true);
  });

  it('dry-run needs exactly one test=true; repeated or mixed values do not qualify', () => {
    const p = policy('test');
    expect(isAllowed(p, 'put', `${VALIDATE}?test=true`)).toBe(true);
    expect(isAllowed(p, 'PUT', `${VALIDATE}?test=true&test=false`)).toBe(false);
    expect(isAllowed(p, 'PUT', `${VALIDATE}?test=false&test=true`)).toBe(false);
    expect(isAllowed(p, 'PUT', `${VALIDATE}?test=true&test=true`)).toBe(false);
  });

  it('prod: allowlisted reads, validate only when enabled, nothing else even with the flag', () => {
    const off = policy('prod');
    const on = policy('prod', false, true);
    expect(isAllowed(off, 'GET', `${B}/v2/apiinfo`)).toBe(true);
    expect(isAllowed(off, 'GET', `${B}/v2/invoices/other`)).toBe(false);
    expect(isAllowed(off, 'PUT', `${VALIDATE}?test=true`)).toBe(false);
    expect(isAllowed(on, 'PUT', `${VALIDATE}?test=true`)).toBe(true);
    expect(isAllowed(on, 'PUT', VALIDATE)).toBe(false);
    expect(isAllowed(on, 'PUT', `${B}/v2/invoices/other?test=true`)).toBe(false);
    expect(isAllowed(on, 'POST', `${VALIDATE}?test=true`)).toBe(false);
    expect(isAllowed(on, 'DELETE', `${B}/v2/apiinfo`)).toBe(false);
    expect(isAllowed(on, 'GET', `${B}/v2/invoices/other`)).toBe(false);
    expect(isAllowed(policy('prod', true, true), 'PUT', `${B}/v2/invoices/other`)).toBe(false);
  });
});

describe('createAgent', () => {
  it('an unusable key is a TlsError naming the profile only', () => {
    const profile = { id: 'p1', key: 'not a key', cert: 'x', passphrase: 'pw' } as Profile;
    let e: unknown;
    try {
      createAgent(profile);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(TlsError);
    expect((e as TlsError).profile).toBe('p1');
    expect((e as TlsError).message).toBe('cannot load client key of profile p1');
  });
});

describe('send', () => {
  const agent = () => ({}) as Dispatcher;
  const url = new URL('https://h.invalid/rest/x');
  const init = (o: Partial<{ timeoutMs: number; maxBytes: number }> = {}) => ({ method: 'GET', headers: {}, timeoutMs: 5000, maxBytes: 10, ...o });
  const reply = (chunks: string[], headers: Record<string, string> = {}) => {
    const body = Readable.from(chunks.map((c) => Buffer.from(c)));
    const destroy = vi.spyOn(body, 'destroy');
    request.mockResolvedValueOnce({ statusCode: 200, headers, body });
    return destroy;
  };
  const caught = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: unknown) => e)) as Error;
  beforeEach(() => request.mockReset());

  it('a body of exactly the cap is accepted (stream and content-length)', async () => {
    reply(['12345', '67890'], { 'content-length': '10' });
    const r = await send(agent(), url, init());
    expect([r.status, r.body, r.bytes]).toEqual([200, '1234567890', 10]);
  });

  it('one byte over the cap by stream: typed error, body destroyed', async () => {
    const destroy = reply(['12345', '678901']);
    const e = await caught(send(agent(), url, init()));
    expect(e).toBeInstanceOf(ResponseTooLargeError);
    expect(e.message).toBe('response exceeds 10 bytes');
    expect(destroy).toHaveBeenCalled();
  });

  it('declared length over the cap fails before reading; list-valued header handled', async () => {
    for (const cl of ['11', ['11', '12']] as const) {
      request.mockReset();
      const body = Readable.from([Buffer.from('x')]);
      const destroy = vi.spyOn(body, 'destroy');
      request.mockResolvedValueOnce({ statusCode: 200, headers: { 'content-length': cl }, body });
      const e = await caught(send(agent(), url, init()));
      expect(e).toBeInstanceOf(ResponseTooLargeError);
      expect(e.message).toBe('response exceeds 10 bytes');
      expect(destroy).toHaveBeenCalled();
    }
  });

  it('declared length equal to the cap is not rejected up front', async () => {
    reply(['abc'], { 'content-length': '10' });
    await expect(send(agent(), url, init())).resolves.toMatchObject({ body: 'abc' });
  });

  it('timeout: message carries the budget', async () => {
    request.mockImplementationOnce((_u: unknown, o: { signal: AbortSignal }) => new Promise((_res, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))));
    const e = await caught(send(agent(), url, init({ timeoutMs: 20 })));
    expect(e).toBeInstanceOf(TimeoutError);
    expect(e.message).toBe('no complete response within 20 ms');
  });

  it.each([
    [{ code: 'ERR_SSL_WRONG' }, TlsError, 'TLS failure (ERR_SSL_WRONG)'],
    [{ cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }, TlsError, 'TLS failure (UNABLE_TO_VERIFY_LEAF_SIGNATURE)'],
    [{ code: 'ECONNRESET' }, TlsError, 'TLS failure (ECONNRESET)'], // first contact: TLS 1.3 client-cert rejection looks like a reset
    [{ code: 'ECONNREFUSED' }, UpstreamError, 'network error (ECONNREFUSED)'],
    [{ cause: { code: 'ENOTFOUND' } }, UpstreamError, 'network error (ENOTFOUND)'],
    [{}, UpstreamError, 'network error ()'],
    [{ code: 'XERR_SSL' }, UpstreamError, 'network error (XERR_SSL)'],
    [{ code: 'MY_CERT_X' }, UpstreamError, 'network error (MY_CERT_X)'],
    [{ code: 'XECONNRESET' }, UpstreamError, 'network error (XECONNRESET)'],
    [{ code: 'XUND_ERR_SOCKET' }, UpstreamError, 'network error (XUND_ERR_SOCKET)'],
  ])('network failure %j', async (raw, Cls, message) => {
    request.mockRejectedValueOnce(raw);
    const e = await caught(send(agent(), url, init()));
    expect(e).toBeInstanceOf(Cls);
    expect(e.message).toBe(message);
  });

  it('after one HTTP response, a reset is upstream', async () => {
    const a = agent();
    reply(['ok']);
    await send(a, url, init());
    request.mockRejectedValueOnce({ code: 'UND_ERR_SOCKET' });
    const e = await caught(send(a, url, init()));
    expect(e).toBeInstanceOf(UpstreamError);
    expect(e.message).toBe('network error (UND_ERR_SOCKET)');
  });
});

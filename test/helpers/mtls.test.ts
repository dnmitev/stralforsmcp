// Harness self-test: proves the runtime PKI and mTLS server work using node:https only.
import { request } from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePki, startServer, type Pki, type TestServer } from './mtls.ts';

let pki: Pki;
let srv: TestServer;
beforeAll(async () => {
  pki = generatePki();
  srv = await startServer((_req, res) => void res.end('pong'), { pki });
});
afterAll(async () => {
  await srv.close();
  pki.cleanup();
});

const get = (cert: { cert: string; key: string; passphrase: string }, ca: string, port: number) =>
  new Promise<string>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path: '/ping', ca, ...cert }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(b));
    });
    r.on('error', reject);
    r.end();
  });

describe('mtls harness', () => {
  it('good client cert (encrypted key) handshakes and server sees the peer cert', async () => {
    expect(await get(pki.client, pki.ca, srv.port)).toBe('pong');
    expect(srv.requests.at(-1)?.peerCert).toBe(true);
  });

  it('foreign client cert is rejected', async () => {
    const before = srv.requests.length;
    await expect(get(pki.foreignClient, pki.ca, srv.port)).rejects.toThrow();
    expect(srv.requests.length).toBe(before);
  });

  it('self-signed server cert is not trusted', async () => {
    const bad = await startServer((_q, res) => void res.end('x'), { pki, serverCert: 'selfSigned' });
    await expect(get(pki.client, pki.ca, bad.port)).rejects.toThrow();
    await bad.close();
  });
});

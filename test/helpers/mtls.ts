// Test PKI + in-process mTLS server. Everything is generated at runtime with the
// openssl CLI (Node has no X.509 issuing API) into a mkdtemp dir; nothing is committed.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface KeyPair {
  cert: string;
  key: string;
}
export interface Pki {
  dir: string;
  /** CA the server certificate and the good client certificate were issued by */
  ca: string;
  server: KeyPair;
  /** Client cert issued by `ca`; key is ENCRYPTED with `passphrase` */
  client: KeyPair & { passphrase: string };
  /** Client cert issued by a different CA (server rejects it); key encrypted with the same passphrase */
  foreignClient: KeyPair & { passphrase: string };
  foreignCa: string;
  /** Self-signed server cert, not issued by `ca` */
  selfSignedServer: KeyPair;
  cleanup(): void;
}

const EC = ['-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256'];

export function generatePki(): Pki {
  const dir = mkdtempSync(join(tmpdir(), 'stralfors-pki-'));
  const ossl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  const passphrase = randomBytes(12).toString('hex');

  const makeCa = (name: string) => {
    ossl('genpkey', ...EC, '-out', `${name}.key`);
    ossl(
      'req', '-x509', '-new', '-key', `${name}.key`, '-subj', `/CN=${name}`, '-days', '2',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign',
      '-out', `${name}.pem`,
    );
  };
  const leaf = (name: string, ca: string, ext: string, pass?: string) => {
    ossl('genpkey', ...EC, '-out', `${name}.plain`);
    ossl('req', '-new', '-key', `${name}.plain`, '-subj', `/CN=${name}`, '-out', `${name}.csr`);
    // encrypt only after the CSR exists (openssl req mishandles -passin on some builds)
    if (pass) ossl('pkcs8', '-topk8', '-v2', 'aes-256-cbc', '-in', `${name}.plain`, '-passout', `pass:${pass}`, '-out', `${name}.key`);
    else ossl('pkcs8', '-topk8', '-nocrypt', '-in', `${name}.plain`, '-out', `${name}.key`);
    writeFileSync(join(dir, `${name}.ext`), ext);
    ossl('x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.pem`, '-CAkey', `${ca}.key`, '-CAcreateserial', '-days', '2', '-extfile', `${name}.ext`, '-out', `${name}.pem`);
    return { cert: read(`${name}.pem`), key: read(`${name}.key`) };
  };

  makeCa('ca');
  makeCa('foreign');
  const server = leaf('server', 'ca', 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n');
  const clientExt = 'basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n';
  const client = leaf('client', 'ca', clientExt, passphrase);
  const foreignClient = leaf('fclient', 'foreign', clientExt, passphrase);
  ossl(
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ss.key', '-out', 'ss.pem',
    '-subj', '/CN=localhost', '-days', '2', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  );

  return {
    dir,
    ca: read('ca.pem'),
    foreignCa: read('foreign.pem'),
    server,
    client: { ...client, passphrase },
    foreignClient: { ...foreignClient, passphrase },
    selfSignedServer: { cert: read('ss.pem'), key: read('ss.key') },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface LoggedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  /** request body as text; filled in once fully received */
  body: string;
  /** true when the client presented a certificate */
  peerCert: boolean;
}
export type Handler = (req: IncomingMessage, res: ServerResponse, entry: LoggedRequest) => void | Promise<void>;
export interface TestServer {
  /** https://127.0.0.1:<port> */
  url: string;
  port: number;
  ca: string;
  requests: LoggedRequest[];
  close(): Promise<void>;
}
export interface ServerOpts {
  pki: Pki;
  /** 'selfSigned' presents a cert the client's trust set does not contain */
  serverCert?: 'trusted' | 'selfSigned';
}

/** Starts an https server that REQUIRES a client cert signed by pki.ca. The handler runs after the body is read. */
export async function startServer(handler: Handler, opts: ServerOpts): Promise<TestServer> {
  const { pki } = opts;
  const id = opts.serverCert === 'selfSigned' ? pki.selfSignedServer : pki.server;
  const requests: LoggedRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(
    { key: id.key, cert: id.cert, ca: pki.ca, requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const entry: LoggedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: '',
        peerCert: Object.keys((req.socket as unknown as { getPeerCertificate(): object }).getPeerCertificate()).length > 0,
      };
      requests.push(entry);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        entry.body = Buffer.concat(chunks).toString('utf8');
        void Promise.resolve(handler(req, res, entry)).catch(() => res.destroy());
      });
    },
  );
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `https://127.0.0.1:${port}`,
    port,
    ca: pki.ca,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

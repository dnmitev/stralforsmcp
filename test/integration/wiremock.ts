// WireMock container that really enforces mutual TLS. Keys, certificates and the keystore password are generated at
// run time into a temp dir and removed again; the container only mounts that dir and the mappings dir, read-only.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePki, type Pki } from '../helpers/mtls.ts';
import { docker, hostPort, removeForce, track, waitFor } from './docker.ts';

// wiremock/wiremock 3.13.2, multi-arch index digest (ADR 0012, ADR 0019). Bump tag and digest together.
const IMAGE = 'wiremock/wiremock@sha256:0d4ecb3e4dc8213fd7a4d37d6a78f6e6b553a6d2e15bd51b0999781282ac61b3';
const MAPPINGS = fileURLToPath(new URL('./mappings', import.meta.url));

export interface JournalEntry {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
export interface WiremockStack {
  /** https://127.0.0.1:<port>; client certificate required */
  httpsBase: string;
  /** http://127.0.0.1:<port>; admin API and request journal, loopback only */
  adminBase: string;
  pki: Pki;
  journal(): Promise<JournalEntry[]>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startWiremock(): Promise<WiremockStack> {
  const pki = generatePki();
  const certDir = mkdtempSync(join(tmpdir(), 'stralfors-wm-'));
  const name = `stralforsmcp-it-${randomBytes(4).toString('hex')}`;
  const cleanFiles = () => {
    pki.cleanup();
    rmSync(certDir, { recursive: true, force: true });
  };
  try {
    const password = randomBytes(16).toString('hex');
    // The container user differs from the host user, so the (test-only, throwaway) store dir must be world-readable.
    mkdirSync(certDir, { recursive: true });
    chmodSync(certDir, 0o755);
    const ossl = (...args: string[]) =>
      execFileSync('openssl', args, { cwd: pki.dir, stdio: 'pipe', env: { ...process.env, WM_PW: password } });
    writeFileSync(join(pki.dir, 'server-chain.pem'), pki.server.cert);
    writeFileSync(join(pki.dir, 'server-key.pem'), pki.server.key, { mode: 0o600 });
    writeFileSync(join(pki.dir, 'ca-trust.pem'), pki.ca);
    ossl('pkcs12', '-export', '-inkey', 'server-key.pem', '-in', 'server-chain.pem', '-name', 'server', '-passout', 'env:WM_PW', '-out', join(certDir, 'keystore.p12'));
    ossl('pkcs12', '-export', '-nokeys', '-jdktrust', 'anyExtendedKeyUsage', '-in', 'ca-trust.pem', '-name', 'ca', '-passout', 'env:WM_PW', '-out', join(certDir, 'truststore.p12'));
    for (const f of ['keystore.p12', 'truststore.p12']) chmodSync(join(certDir, f), 0o644);

    track(name);
    await docker([
      'run', '-d', '--rm', '--name', name,
      '-p', '127.0.0.1::8080', '-p', '127.0.0.1::8443',
      '-v', `${MAPPINGS}:/home/wiremock/mappings:ro`,
      '-v', `${certDir}:/certs:ro`,
      IMAGE,
      '--port', '8080', '--https-port', '8443',
      '--https-keystore', '/certs/keystore.p12', '--keystore-type', 'PKCS12', '--keystore-password', password, '--key-manager-password', password,
      '--https-require-client-cert',
      '--https-truststore', '/certs/truststore.p12', '--truststore-type', 'PKCS12', '--truststore-password', password,
    ], 120_000);
    const adminBase = `http://127.0.0.1:${await hostPort(name, '8080/tcp')}`;
    const httpsBase = `https://127.0.0.1:${await hostPort(name, '8443/tcp')}`;
    await waitFor(`${adminBase}/__admin/health`, 60_000);

    return {
      httpsBase,
      adminBase,
      pki,
      async journal() {
        const res = await fetch(`${adminBase}/__admin/requests`);
        const { requests } = (await res.json()) as { requests: { request: JournalEntry }[] };
        return requests.map((r) => r.request);
      },
      async reset() {
        await fetch(`${adminBase}/__admin/requests`, { method: 'DELETE' });
      },
      async stop() {
        try {
          await removeForce(name);
        } finally {
          cleanFiles();
        }
      },
    };
  } catch (e) {
    await removeForce(name).catch(() => {});
    cleanFiles();
    throw e;
  }
}

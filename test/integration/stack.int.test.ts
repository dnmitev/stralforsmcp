import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, loadConfig } from '../../src/stralfors/index.ts';
import { makeEnv } from '../helpers/api.ts';
import { integrationEnabled } from './docker.ts';
import { startWiremock, type WiremockStack } from './wiremock.ts';

const enabled = await integrationEnabled();

describe.skipIf(!enabled)('mTLS stack (WireMock container)', () => {
  let wm: WiremockStack;
  beforeAll(async () => {
    wm = await startWiremock();
  });
  afterAll(async () => {
    await wm?.stop();
  });

  const client = (o: { who?: 'client' | 'foreign'; noCert?: boolean }) => {
    const config = loadConfig(makeEnv(wm.pki, { who: o.who }).env);
    return createClient({
      config, profileId: 'a', ca: wm.pki.ca, baseUrl: wm.httpsBase,
      ...(o.noCert && { createAgent: (_p, opts) => new Agent({ connect: { ca: opts?.ca, rejectUnauthorized: true } }) }),
    });
  };
  const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

  it('serves the good client and refuses foreign-CA and certless clients without serving them', async () => {
    await wm.reset();
    await expect(client({}).apiInfo()).resolves.toMatchObject({ name: 'ApiOmni' });
    const served = await wm.journal();
    // the journal lists newest first; compare as a set
    expect(served.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      'GET /rest/outputmanagement/apiomni/v2/apiinfo',
      'POST /v1/oidc/token',
    ]);

    for (const bad of [client({ who: 'foreign' }), client({ noCert: true })]) {
      const err = await rejection(bad.apiInfo());
      expect(err).toMatchObject({ kind: 'tls' });
      expect(String((err as Error).message)).toMatch(/^TLS failure \(/);
    }
    expect(await wm.journal()).toHaveLength(served.length);
  });
});

// The real server (start()) with one profile pointed at the WireMock container, plus an SDK client and capture sinks.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { createClient } from '../../src/stralfors/index.ts';
import { start, type Started } from '../../src/server/main.ts';
import { makeEnv } from '../helpers/api.ts';
import { connect, sink } from '../helpers/server.ts';
import { memTelemetry } from '../helpers/telemetry.ts';
import { fixture, T } from '../helpers/token-list.ts';
import type { WiremockStack } from './wiremock.ts';

/** Agreement ids of the stub set (synthetic). The tools only ever see their labels. */
export const AGR = { main: '10000000-0000-4000-8000-000000000001', alt: '10000000-0000-4000-8000-000000000002', gone: '10000000-0000-4000-8000-000000000003' };

export const query = (url: string) => new URL(url, 'https://x').searchParams;

/** `extra`: more server env, e.g. STRALFORS_ALLOW_WRITE for the send tests. */
export async function bootWorld(wm: WiremockStack, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smcp-it-'));
  const f = fixture();
  const tokenFile = join(dir, 'access.json');
  writeFileSync(tokenFile, f.text());
  const profile = makeEnv(wm.pki, { id: 'a', extra: { STRALFORS_PROFILE_A_ACTION_IDS: `main:${AGR.main},alt:${AGR.alt},gone:${AGR.gone}` } });
  const env = { ...profile.env, MCP_TOKEN_LIST_FILE: tokenFile, MCP_HOSTNAMES: '127.0.0.1', MCP_PORT: '0', MCP_LISTEN_HOST: '127.0.0.1', MCP_METRICS_PORT: '0', MCP_METRICS_HOST: '127.0.0.1', MCP_RATE_BURST: '500', MCP_RATE_PER_MINUTE: '5000', ...extra };
  const err: string[] = [];
  const audit = sink();
  const tel = memTelemetry();
  const s: Started = await start(env, {
    stderr: { write: (x) => void err.push(x) }, audit: audit.audit, telemetry: tel.t, now: () => T, onSignal: () => undefined,
    clientFactory: (o) => createClient({ ...o, ca: wm.pki.ca, baseUrl: wm.httpsBase }),
  });
  const token = f.raw.tA;
  const bearer: typeof fetch = (url, init) =>
    fetch(`http://127.0.0.1:${s.port}${new URL(String(url)).pathname}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${token}` } });
  let client: Client;
  try {
    client = await connect('modern', bearer);
  } catch (e) {
    await s.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return {
    client, audit, tel, profile,
    /** server log lines (stderr) as one text */
    logs: () => err.join(''),
    call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }),
    /** run-time secrets and ids that must never surface anywhere */
    secrets: () => [profile.clientId, profile.clientSecret, profile.passphrase, token, ...Object.values(AGR)],
    close: async () => {
      try {
        await client.close().catch(() => undefined);
        await s.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
export type World = Awaited<ReturnType<typeof bootWorld>>;

/** The structured result of a successful call, or throws with the tool's error text. */
export const ok = (r: Awaited<ReturnType<World['call']>>): Record<string, any> => {
  if (r.isError) throw new Error(`tool error: ${JSON.stringify(r.content)}`);
  return r.structuredContent as Record<string, any>;
};
export const errText = (r: Awaited<ReturnType<World['call']>>): string => {
  if (!r.isError) throw new Error('expected a tool error');
  return (r.content as { text: string }[])[0]!.text;
};

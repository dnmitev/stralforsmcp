// Two-profile Stralfors world for the 02-03 tests: in-process mTLS fake API (Phase 1 helpers) + real temp-file env. All ids are generated at run time.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient, loadConfig, type Config, type StralforsClient } from '../../src/stralfors/index.ts';
import { json, makeEnv, startFakeApi, type FakeApi, type ProfileFiles } from './api.ts';
import type { Pki } from './mtls.ts';

export const CHANNELS_PATH = '/rest/outputmanagement/apiomni/v2/invoices/channels';
export const CHANNELS = ['eInvoice', 'eMail', 'Custom', 'eMail'];
type Reply = (req: IncomingMessage, res: ServerResponse) => void;

/** Fake whose channels route is switchable through `reply.current`. */
export async function startChannelsApi(pki: Pki, o: { serverCert?: 'trusted' | 'selfSigned'; body?: unknown } = {}) {
  const reply: { current: Reply } = { current: (_q, res) => json(res, 200, o.body ?? CHANNELS) };
  const fake = await startFakeApi({
    pki, serverCert: o.serverCert,
    api: (req, res) => (req.url!.split('?')[0] === CHANNELS_PATH ? reply.current(req, res) : json(res, 404, 'No Mapping Rule matched', 'text/plain')),
  });
  return { fake, reply, channelRequests: () => fake.apiRequests.filter((r) => r.url.split('?')[0] === CHANNELS_PATH) };
}

export interface TwoProfiles {
  env: Record<string, string>;
  files: { a: ProfileFiles; b: ProfileFiles };
  uuid: { a: string; aNoLabel: string; b: string };
  secrets: string[];
}
/** Profiles a (labelled agreement "billing" + one unlabelled) and b (agreement "letters"), config order a, b. */
export function twoProfiles(pki: Pki, extra: Record<string, string | undefined> = {}): TwoProfiles {
  const uuid = { a: randomUUID(), aNoLabel: randomUUID(), b: randomUUID() };
  const a = makeEnv(pki, { id: 'a', extra: { STRALFORS_PROFILE_A_ACTION_IDS: `billing:${uuid.a},${uuid.aNoLabel}` } });
  const b = makeEnv(pki, { id: 'b', extra: { STRALFORS_PROFILE_B_ACTION_IDS: `letters:${uuid.b}` } });
  const env: Record<string, string> = { ...a.env, ...b.env, STRALFORS_PROFILES: 'a,b' };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return { env, files: { a, b }, uuid, secrets: [a.clientId, a.clientSecret, a.passphrase, b.clientId, b.clientSecret, b.passphrase] };
}

/** Real clients against the fake, keyed by profile id in config order. */
export function realClients(pki: Pki, fake: FakeApi, config: Config): Map<string, StralforsClient> {
  return new Map(Object.keys(config.profiles).map((id) => [id, createClient({ config, profileId: id, ca: pki.ca, baseUrl: fake.url })]));
}
export { loadConfig };

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AgreementNotFoundError, ConfigError, SchemaError, createClient, loadConfig, StralforsError, type Profile, type StralforsClient } from '../src/stralfors/index.ts';
import { createListChannels } from '../src/server/channels.ts';
import { createRulesCache } from '../src/server/rules-cache.ts';
import { loadRules } from '../src/server/rules-load.ts';
import { createGetExampleInvoice, createGetRules } from '../src/server/rules-tools.ts';
import { safeMessage } from '../src/stralfors/tracking.ts';
import { createTrackDocument } from '../src/server/track-tool.ts';
import { ToolInputError, type ToolContext } from '../src/server/tools.ts';

type ReadClient = Pick<StralforsClient, 'token' | 'channels' | 'rules' | 'documentExample' | 'trackDocuments' | 'trackHistory'>;
export interface Deps { client: ReadClient; profile: { id: string; agreements: Profile['agreements'] }; env: 'test' | 'prod' }
export interface Opts { channels?: string[]; invoiceNumber?: string; agreementProbe?: boolean; now?: () => number }

const norm = (id: string) => id.trim().toUpperCase().replaceAll('-', '_');
/** LIVE_PROFILE picks one profile with the config's id rule (case-insensitive, - equals _); unset means the first. The error never echoes the value or lists ids. */
export function pickProfile<T extends { id: string }>(profiles: Record<string, T>, sel: string | undefined): T {
  const all = Object.values(profiles);
  const p = sel?.trim() ? all.find((x) => norm(x.id) === norm(sel)) : all[0];
  if (!p) throw new ConfigError(sel?.trim() ? 'unknown LIVE_PROFILE' : 'no profile configured');
  return p;
}

/** LIVE_CHECK_CHANNELS: comma list, trimmed, empty entries dropped; nothing usable gives undefined. */
export function parseChannels(env: string | undefined): string[] | undefined {
  const list = (env ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

const leaves = (v: unknown): number => (v !== null && typeof v === 'object' ? Object.values(v).reduce<number>((n, x) => n + leaves(x), 0) : 1);
/** A status is printed only when it is exactly a known status name; anything else may be free text and shows its length only. */
const shown = (s: unknown): string => {
  const t = String(s);
  return safeMessage(t) !== undefined ? t : `<other len=${t.length}>`;
};
const ANSWERED = new Error('answered'); // the agreement probe got channels for a made-up id
const kindOf = (e: unknown) => (e instanceof StralforsError ? e.kind : e instanceof ToolInputError ? 'input' : e === ANSWERED ? 'unexpected' : 'unknown');

/** Builds the report from the real read tools. Shapes only: counts, kinds, key names, outcomes; never a value, id or upstream message. */
export async function report({ client, profile, env }: Deps, opts: Opts = {}): Promise<string> {
  const { scopes, exp, customerCountry } = (await client.token.get()).claims.summary();
  const out = [`env: ${env}`, `profile: ${profile.id}`, `scopes: ${scopes.join(' ')}`, `exp: ${exp}`, `customerCountry: ${customerCountry ?? 'none'}`];
  const clients = new Map([[profile.id, client]]);
  const cache = createRulesCache({ ttlMs: 60_000 });
  const ctx = {} as ToolContext; // the read tools never touch the context
  const listChannels = createListChannels({ clients, config: { profiles: { [profile.id]: profile as Profile } } });
  const getRules = createGetRules({ clients, cache });
  const getExample = createGetExampleInvoice({ clients });
  const track = createTrackDocument({ clients, ...(opts.now ? { now: opts.now } : {}) });
  const step = async (name: string, f: () => Promise<string>) => {
    try { out.push(`ok ${name}: ${await f()}`); } catch (e) {
      // a schema miss names the failing schema paths (our own keys and indexes, never a value) so a live run shows what to fix
      const at = e instanceof SchemaError ? ` at ${[...new Set(e.issues.map((i) => i.path || '(root)'))].slice(0, 10).join(', ')}` : '';
      out.push(`fail ${kindOf(e)} ${name}:${at}`);
    }
  };

  for (const [i, a] of profile.agreements.entries()) {
    const label = a.label ?? `#${i + 1}`;
    const byTool = a.label !== undefined && profile.agreements.filter((x) => x.label === a.label).length === 1;
    await step(`list_channels ${label}`, async () => (await (byTool ? listChannels.run({ agreement: a.label }, ctx).then((r) => r.channels) : client.channels(a.id))).join(', ')); // the tool resolves by label (first match): unlabelled and duplicate-labelled agreements go straight to the client
  }
  // R-38: a made-up agreement id must come back as a JSON 404 (agreement_not_found), never as a route 404 or a success
  if (opts.agreementProbe) await step('agreement probe', async () => {
    try { await client.channels(randomUUID()); } catch (e) { if (e instanceof AgreementNotFoundError) return e.kind; throw e; }
    throw ANSWERED;
  });
  let chosen = opts.channels ?? [];
  if (!opts.channels) await step('discover channels', async () => { chosen = (await client.channels()).slice(0, 2); return `${chosen.length} channels`; });
  for (const channel of chosen) {
    await step(`get_rules ${channel}`, async () => {
      const { total } = await getRules.run({ channel }, ctx);
      const { readable, local } = await loadRules(cache, client, profile.id, channel, 0);
      const kinds: Record<string, number> = {};
      for (const k of local.flatMap((r) => r.criteria.map((c) => c.kind))) kinds[k] = (kinds[k] ?? 0) + 1;
      const hist = Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}=${n}`).join(', ');
      return `total=${total} required=${readable.filter((r) => r.required).length} unknown=${kinds['unknown'] ?? 0} kinds: ${hist}`;
    });
    await step(`get_example_invoice ${channel}`, async () => {
      const { example } = await getExample.run({ channels: [channel] }, ctx);
      return `keys: ${Object.keys(example).sort().join(', ')} leaves=${leaves(example)}`;
    });
  }
  if (opts.invoiceNumber === undefined) out.push('track: skipped (set LIVE_CHECK_INVOICE_NUMBER)');
  else {
    const invoiceNumber = opts.invoiceNumber;
    await step('track', async () => {
      const r = await track.run({ invoiceNumber }, ctx);
      const lines = [`documents=${r.documents.length} hasMore=${r.hasMore}`];
      for (const [i, d] of r.documents.entries()) {
        lines.push(`  document #${i + 1} outcome=${d.outcome}`);
        for (const c of d.channels) lines.push(`    channelId=${String(c['channelId'])} status=${shown(c['status'])} outcome=${c.outcome}`);
      }
      return lines.join('\n');
    });
  }
  return out.join('\n');
}

async function main(): Promise<number> {
  let client: ReturnType<typeof createClient> | undefined;
  try {
    const config = loadConfig(process.env);
    const profile = pickProfile(config.profiles, process.env['LIVE_PROFILE']);
    client = createClient({ config, profileId: profile.id });
    const text = await report({ client, profile, env: config.env }, { channels: parseChannels(process.env['LIVE_CHECK_CHANNELS']), invoiceNumber: process.env['LIVE_CHECK_INVOICE_NUMBER'] || undefined, agreementProbe: process.env['LIVE_CHECK_AGREEMENT_PROBE'] === '1' });
    console.log(text);
    return /^fail /m.test(text) ? 1 : 0;
  } catch (e) {
    console.error(e instanceof StralforsError ? `${e.kind}: ${e.message}` : 'unknown error');
    return 1;
  } finally {
    await client?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = await main();
}

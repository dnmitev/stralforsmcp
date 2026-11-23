/** Local drift runner (manual, never in CI): GET-only reads from one environment, compared with what the code understands. Report and baseline go to a private directory outside the repo; stdout shows counts only. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ConfigError, createClient, loadConfig, StralforsError, type StralforsClient } from '../../src/stralfors/index.ts';
import { pickProfile } from '../live-read-check.ts';
import type { RuleNode } from '../../src/stralfors/rules.ts';
import { badPatterns, channelDiff, criteriaHashes, hashDiff, templateShape, unknownKinds, versionDiff, type Finding } from './checks.ts';

type DriftClient = Pick<StralforsClient, 'apiInfo' | 'channels' | 'templates' | 'rules'>;
const STABLE = ['unknown-criterion', 'pattern-not-compilable'];
// `standing` (per channel) replaced the flat `counts` total in 06-01; a file with only `counts` is still read and compared by totals
const baselineSchema = z.object({ counts: z.record(z.string(), z.number()).optional(), standing: z.record(z.string(), z.record(z.string(), z.number())).optional(), channels: z.array(z.string()), templates: z.array(z.number()), version: z.string().optional(), rules: z.record(z.string(), z.array(z.string())) });
export type Baseline = z.infer<typeof baselineSchema>;
export interface Opts { expectChannels?: string[] | undefined; expectVersion?: string | undefined; baseline?: Baseline | undefined }
/** `complete` is false when any fetch failed: such a baseline would silently drop what could not be read, so it must not replace a good one */
export interface Result { findings: Finding[]; report: string; baseline: Baseline; complete: boolean }

const REFUSAL = 'drift: DRIFT_OUT must be an absolute path to a directory outside the repository checkout';
const REPO = resolve(import.meta.dirname, '../..');
// ponytail: lexical check only; a symlink from outside into the repo is not followed. Add realpath if that ever matters.
export function outDirOk(out: string | undefined, repo = REPO): out is string {
  if (!out || !isAbsolute(out)) return false;
  const rel = relative(repo, resolve(out));
  return rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)); // a child named `..x` is inside the repo
}

/** one baseline per env and profile; the id is made path-safe (it is a config label, never a path) */
export const baselineFile = (out: string, env: string, profileId: string) => join(out, `baseline-${env}-${profileId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

const kindOf = (e: unknown) => (e instanceof StralforsError ? e.kind : 'unknown');
const list = (s: string | undefined) => { const l = (s ?? '').split(',').map((x) => x.trim()).filter(Boolean); return l.length > 0 ? l : undefined; };

export async function runDrift({ client, env, profile }: { client: DriftClient; env: string; profile?: string }, opts: Opts = {}): Promise<Result> {
  const findings: Finding[] = [];
  const lines: string[] = [];
  const base = opts.baseline;
  const fetched = async <T>(op: string, f: () => Promise<T>): Promise<T | undefined> => {
    try { return await f(); } catch (e) { findings.push({ check: 'fetch-failed', count: 1 }); lines.push(`fetch-failed ${op}: ${kindOf(e)}`); return undefined; }
  };

  const info = await fetched('apiInfo', () => client.apiInfo());
  const fetchedChannels = await fetched('channels', () => client.channels());
  const channels = fetchedChannels ?? [];
  const templates = (await fetched('templates', () => client.templates())) ?? [];
  const expectVersion = opts.expectVersion ?? base?.version;
  const expectChannels = opts.expectChannels ?? base?.channels;
  if (info) findings.push(...versionDiff(info.version, expectVersion));
  if (fetchedChannels) findings.push(...channelDiff(fetchedChannels, expectChannels)); // a successful empty catalogue is compared too; only a failed fetch is skipped
  findings.push(...templateShape(templates));
  const newTemplates = base ? templates.filter((t) => !base.templates.includes(t.standardId)).length : 0;
  if (newTemplates > 0) findings.push({ check: 'template-new', count: newTemplates });

  const rules: Record<string, string[]> = {};
  const standing: Record<string, Record<string, number>> = {};
  const total = (fs: Finding[], c: string) => fs.filter((f) => f.check === c).reduce((n, f) => n + f.count, 0);
  for (const channel of channels) {
    const r = await fetched('rules', () => client.rules(channel));
    if (!r) continue;
    const tree = r.rules as RuleNode[];
    rules[channel] = criteriaHashes(tree);
    const here = [...unknownKinds(tree), ...badPatterns(tree), ...(base?.rules[channel] ? hashDiff(rules[channel], base.rules[channel]) : [])];
    standing[channel] = Object.fromEntries(STABLE.map((c) => [c, total(here, c)]));
    findings.push(...here);
    lines.push(`rules #${Object.keys(rules).length}: rules=${tree.length} findings=${here.reduce((n, f) => n + f.count, 0)}`);
  }

  // known, standing facts of the environment (unknown kinds, .NET-only patterns) are drift only when their count changes against the baseline,
  // compared per channel (a loss in one cannot cancel a gain in another); a channel whose rules fetch failed is absent from `standing` and not compared
  const counts = Object.fromEntries(STABLE.map((c) => [c, total(findings, c)]));
  const changed = (c: string) => base?.standing
    ? Object.entries(standing).reduce((n, [ch, s]) => n + Math.abs(s[c]! - (base.standing![ch]?.[c] ?? 0)), 0)
    : Math.abs(counts[c]! - (base?.counts?.[c] ?? 0));
  const stable = base?.standing ?? base?.counts;
  const out = stable ? [...findings.filter((f) => !STABLE.includes(f.check)), ...STABLE.map((c) => ({ check: c, count: changed(c) })).filter((f) => f.count > 0)] : findings;
  const byCheck = new Map<string, number>();
  for (const f of out) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + f.count);
  const report = [
    `# Drift report`, `env: ${env}`, ...(profile !== undefined ? [`profile: ${profile}`] : []), `channels: ${channels.length} templates: ${templates.length}`,
    `expectations: version ${expectVersion === undefined ? 'skipped' : 'set'}, channels ${expectChannels === undefined ? 'skipped' : 'set'}, baseline ${base ? 'present' : 'none'}`,
    ...(base && !base.standing ? ['baseline: old format, rewrite with DRIFT_WRITE_BASELINE=1'] : []),
    ...lines, `findings: ${out.length === 0 ? 'none' : out.reduce((n, f) => n + f.count, 0)}${stable ? '' : ' (no baseline: standing unknown kinds and patterns included)'}`, ...[...byCheck].map(([c, n]) => `- ${c}: ${n}`),
  ].join('\n');
  return { findings: out, report, complete: !findings.some((f) => f.check === 'fetch-failed'), baseline: { standing, channels: [...channels], templates: templates.map((t) => t.standardId), ...(info?.version !== undefined ? { version: info.version } : {}), rules } };
}

async function main(): Promise<number> {
  const out = process.env['DRIFT_OUT'];
  if (!outDirOk(out)) { console.error(REFUSAL); return 1; }
  let client: ReturnType<typeof createClient> | undefined;
  try {
    const config = loadConfig(process.env);
    const profile = pickProfile(config.profiles, process.env['LIVE_PROFILE']);
    const file = baselineFile(out, config.env, profile.id);
    const baseline = existsSync(file) ? baselineSchema.parse(JSON.parse(await readFile(file, 'utf8'))) : undefined;
    client = createClient({ config, profileId: profile.id });
    const res = await runDrift({ client, env: config.env, profile: profile.id }, { expectChannels: list(process.env['DRIFT_EXPECT_CHANNELS']), expectVersion: process.env['DRIFT_EXPECT_API_VERSION'] || undefined, baseline });
    await mkdir(out, { recursive: true, mode: 0o700 });
    const name = `drift-${config.env}-${profile.id.replace(/[^A-Za-z0-9_-]/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    await writeFile(join(out, name), `${res.report}\n`, { mode: 0o600 });
    if (process.env['DRIFT_WRITE_BASELINE'] === '1') {
      if (res.complete) await writeFile(file, `${JSON.stringify(res.baseline)}\n`, { mode: 0o600 });
      else console.error('drift: a fetch failed, baseline not written');
    }
    console.log(['env: ' + config.env, `profile: ${profile.id}`, `findings: ${res.findings.reduce((n, f) => n + f.count, 0)}`, ...[...new Set(res.findings.map((f) => f.check))].map((c) => `  ${c}: ${res.findings.filter((f) => f.check === c).reduce((n, f) => n + f.count, 0)}`), `report: ${name}`].join('\n'));
    return res.findings.length > 0 ? 1 : 0;
  } catch (e) {
    console.error(e instanceof StralforsError ? `${e.kind}: ${e.message}` : e instanceof ConfigError ? e.message : 'drift: unexpected error');
    return 1;
  } finally {
    await client?.close().catch(() => console.error('drift: client close failed'));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) process.exitCode = await main();

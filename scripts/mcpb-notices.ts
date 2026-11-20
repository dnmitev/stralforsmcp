// Third-party notices for the .mcpb bundle: every npm package whose code esbuild put in the bundle, with its licence text.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const NM = 'node_modules/';
const LICENCE_FILE = /^(licen[sc]e|copying)([.-].*)?$/i;
const NOTICE_FILE = /^notice([.-].*)?$/i;

/** Package directories (absolute, unique, sorted) for the node_modules inputs of an esbuild metafile; own code is ignored. */
export function bundledPackageDirs(inputs: string[], root: string): string[] {
  const dirs = new Set<string>();
  for (const p of inputs) {
    const at = p.lastIndexOf(NM);
    if (at < 0) continue;
    const segs = p.slice(at + NM.length).split('/');
    const name = segs[0]?.startsWith('@') ? segs.slice(0, 2).join('/') : (segs[0] ?? '');
    if (name === '') continue;
    dirs.add(join(root, p.slice(0, at + NM.length), name));
  }
  return [...dirs].sort();
}

interface Pkg { name: string; version: string; license?: unknown; licenses?: unknown }

const licenceOf = (p: Pkg): string | undefined => {
  const l = p.license ?? (Array.isArray(p.licenses) ? p.licenses[0] : undefined);
  if (typeof l === 'string' && l !== '') return l;
  if (typeof l === 'object' && l !== null && typeof (l as { type?: unknown }).type === 'string') return (l as { type: string }).type;
  return undefined;
};

/** Deterministic notices text. Throws when a package has no licence field or no licence file with text (a NOTICE alone does not count). */
export function buildNotices(dirs: string[]): string {
  const entries = dirs.map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Pkg;
    const id = `${pkg.name} ${pkg.version}`;
    const license = licenceOf(pkg);
    if (license === undefined) throw new Error(`${id}: package.json has no license field`);
    const names = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
    const read = (re: RegExp) =>
      names
        .filter((f) => re.test(f))
        .sort()
        .map((f) => ({ f, t: readFileSync(join(dir, f), 'utf8').trim() }))
        .filter((x) => x.t !== '');
    // The licence text must come from a licence file: a NOTICE (copyright statement) is added to it, never a substitute.
    const licences = read(LICENCE_FILE);
    if (licences.length === 0) throw new Error(`${id}: no licence text found`);
    const body = [...licences, ...read(NOTICE_FILE)].map(({ f, t }) => `${f}:\n${t}`).join('\n\n');
    return { id, name: pkg.name, text: `== ${id} ==\nLicense: ${license}\n\n${body}\n` };
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return `Third-party software bundled in stralforsmcp.mcpb\n\n${entries.map((e) => e.text).join('\n')}`;
}

import { open, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { ConfigError } from '../stralfors/errors.ts';
import { parseDoc, type KnowledgeDoc } from './doc.ts';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_DOCS = 500;
/** Directories below the root that are entered; a file in root/a/b/c/d/ is at depth 4. */
export const MAX_DEPTH = 4;
/** Entries (files and directories, any extension) looked at per directory tree before the walk stops. */
export const MAX_SCANNED = 5000;

export type LoadWarning = { source: 'public' | 'private'; text: string };
export type LoadResult = { docs: KnowledgeDoc[]; warnings: LoadWarning[] };

// Sorted depth-first walk; the cut-offs are silent (a log line per skipped file would be a flood).
const walk = async (root: string): Promise<{ path: string; name: string }[]> => {
  const out: { path: string; name: string }[] = [];
  let scanned = 0;
  const go = async (dir: string, depth: number): Promise<void> => {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (++scanned > MAX_SCANNED) return;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) await go(path, depth + 1);
      } else if (e.name.endsWith('.md')) out.push({ path, name: e.name });
      if (scanned > MAX_SCANNED) return;
    }
  };
  await go(root, 0);
  return out;
};

// undefined: not a regular file; null: over the size cap. One opened handle: stat and read cannot be split by a swap, and the read is bounded whatever the size said.
const readBounded = async (path: string): Promise<string | null | undefined> => {
  const fh = await open(path, 'r');
  try {
    if (!(await fh.stat()).isFile()) return undefined;
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r) r = (await fh.read(buf, n, buf.length - n, n)).bytesRead;
    return n > MAX_FILE_BYTES ? null : buf.toString('utf8', 0, n);
  } finally {
    await fh.close();
  }
};

// Warnings are fixed text plus the base file name: never content, never a directory path.
// Admission to the 500-doc limit happens here, before a body is kept, so a huge overlay cannot fill memory: a known id is always replaced, a new id only while there is room.
const readDir = async (dir: string, source: 'public' | 'private', unreadable: string, all: Map<string, KnowledgeDoc>) => {
  let root: string;
  let files: { path: string; name: string }[];
  try {
    root = await realpath(dir);
    files = await walk(root);
  } catch {
    throw new ConfigError(unreadable);
  }
  const seen = new Set<string>(); // first sorted file wins inside one directory
  const warnings: LoadWarning[] = [];
  const warn = (text: string) => warnings.push({ source, text });
  let capped = false;
  for (const { path, name } of files) {
    try {
      const real = await realpath(path);
      if (!real.startsWith(root + sep)) continue; // symlink escape: ignored
      const raw = await readBounded(real);
      if (raw === undefined) continue;
      if (raw === null) {
        warn(`skipped ${name}: file too large`);
        continue;
      }
      const r = parseDoc(raw, source);
      if (!r.ok) warn(`skipped ${name}: invalid document`);
      else if (seen.has(r.doc.id)) warn(`skipped ${name}: duplicate id`);
      else {
        seen.add(r.doc.id);
        if (all.has(r.doc.id) || all.size < MAX_DOCS) all.set(r.doc.id, r.doc); // replace by id is silent
        else capped = true;
      }
    } catch {
      warn(`skipped ${name}: unreadable`);
    }
  }
  return { warnings, capped };
};

export const loadKnowledge = async (opts: { publicDir: string; overlayDirs: string[] }): Promise<LoadResult> => {
  const all = new Map<string, KnowledgeDoc>();
  const warnings: LoadWarning[] = [];
  const dirs = [
    { dir: opts.publicDir, source: 'public' as const, msg: 'knowledge directory is not readable' },
    ...opts.overlayDirs.map((dir) => ({ dir, source: 'private' as const, msg: 'KNOWLEDGE_DIRS is not readable' })),
  ];
  let capped = false;
  for (const { dir, source, msg } of dirs) {
    const r = await readDir(dir, source, msg, all);
    warnings.push(...r.warnings);
    capped ||= r.capped;
  }
  if (capped) warnings.push({ source: 'private', text: `document limit of ${MAX_DOCS} reached, extra documents ignored` });
  return { docs: [...all.values()], warnings };
};

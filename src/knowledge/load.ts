import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
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
// An unreadable nested directory is a warning, like an unreadable file; only the root failing is fatal. A directory is re-checked with lstat before descent so one swapped for a symlink after the listing is not followed (a small gap remains: the per-file realpath check and O_NOFOLLOW narrow it but do not close it if a writer can also swap an ancestor directory, so the overlay mount must not be writable by untrusted parties).
const isDir = (path: string) => lstat(path).then((st) => st.isDirectory(), () => false);
const walk = async (root: string, warn: (text: string) => void): Promise<{ path: string; name: string }[]> => {
  const out: { path: string; name: string }[] = [];
  let scanned = 0;
  const go = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (depth === 0) throw e;
      warn(`skipped ${basename(dir)}: unreadable`);
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (++scanned > MAX_SCANNED) return;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && (await isDir(path))) await go(path, depth + 1);
      } else if (e.name.endsWith('.md')) out.push({ path, name: e.name });
    }
  };
  await go(root, 0);
  return out;
};

// undefined: not a regular file; null: over the size cap. One opened handle: stat and read cannot be split by a swap, and the read is bounded whatever the size said.
const readBounded = async (path: string): Promise<string | null | undefined> => {
  // O_NOFOLLOW: the path is already a realpath, so a final component swapped for a symlink after the check fails to open (ELOOP, reported as unreadable) instead of being followed. A swapped ancestor directory is not covered; that needs a writer inside the overlay mount. O_NONBLOCK: a FIFO named *.md would otherwise block open() until a writer appears and hang start-up; with it the open returns at once and the isFile check below skips it.
  const fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await fh.stat()).isFile()) return undefined;
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return n > MAX_FILE_BYTES ? null : buf.toString('utf8', 0, n);
  } finally {
    await fh.close();
  }
};

// Warnings are fixed text plus the base file name: never content, never a directory path.
// Admission to the 500-doc limit happens here, before a body is kept, so a huge overlay cannot fill memory: a known id is always replaced, a new id only while there is room.
const readDir = async (dir: string, source: 'public' | 'private', unreadable: string, all: Map<string, KnowledgeDoc>) => {
  const warnings: LoadWarning[] = [];
  const warn = (text: string) => warnings.push({ source, text });
  let root: string;
  let files: { path: string; name: string }[];
  try {
    root = await realpath(dir);
    files = await walk(root, warn);
  } catch {
    throw new ConfigError(unreadable);
  }
  const seen = new Set<string>(); // first sorted file wins inside one directory
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

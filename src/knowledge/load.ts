import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { ConfigError } from '../stralfors/errors.ts';
import { parseDoc, type KnowledgeDoc } from './doc.ts';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_DOCS = 500;

export type LoadResult = { docs: KnowledgeDoc[]; warnings: string[] };

// Warnings are fixed text plus the base file name: never content, never a directory path.
// Admission to the 500-doc limit happens here, before a body is kept, so a huge overlay cannot fill memory: a known id is always replaced, a new id only while there is room.
const readDir = async (dir: string, source: 'public' | 'private', unreadable: string, all: Map<string, KnowledgeDoc>) => {
  let root: string;
  let names: string[];
  try {
    root = await realpath(dir);
    names = await readdir(root, { recursive: true });
  } catch {
    throw new ConfigError(unreadable);
  }
  const seen = new Set<string>(); // first sorted file wins inside one directory
  const warnings: string[] = [];
  let capped = false;
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    const base = basename(name);
    try {
      const real = await realpath(join(root, name));
      if (!real.startsWith(root + sep)) continue; // symlink escape: ignored
      const st = await stat(real);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) {
        warnings.push(`skipped ${base}: file too large`);
        continue;
      }
      const r = parseDoc(await readFile(real, 'utf8'), source);
      if (!r.ok) warnings.push(`skipped ${base}: invalid document`);
      else if (seen.has(r.doc.id)) warnings.push(`skipped ${base}: duplicate id`);
      else {
        seen.add(r.doc.id);
        if (all.has(r.doc.id) || all.size < MAX_DOCS) all.set(r.doc.id, r.doc); // replace by id is silent
        else capped = true;
      }
    } catch {
      warnings.push(`skipped ${base}: unreadable`);
    }
  }
  return { warnings, capped };
};

export const loadKnowledge = async (opts: { publicDir: string; overlayDirs: string[] }): Promise<LoadResult> => {
  const all = new Map<string, KnowledgeDoc>();
  const warnings: string[] = [];
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
  if (capped) warnings.push(`document limit of ${MAX_DOCS} reached, extra documents ignored`);
  return { docs: [...all.values()], warnings };
};

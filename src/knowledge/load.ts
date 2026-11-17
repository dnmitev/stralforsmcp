import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { ConfigError } from '../stralfors/errors.ts';
import { parseDoc, type KnowledgeDoc } from './doc.ts';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_DOCS = 500;

export type LoadResult = { docs: KnowledgeDoc[]; warnings: string[] };

// Warnings are fixed text plus the base file name: never content, never a directory path.
const readDir = async (dir: string, source: 'public' | 'private', unreadable: string) => {
  let root: string;
  let names: string[];
  try {
    root = await realpath(dir);
    names = await readdir(root, { recursive: true });
  } catch {
    throw new ConfigError(unreadable);
  }
  const docs = new Map<string, KnowledgeDoc>();
  const warnings: string[] = [];
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
      else if (docs.has(r.doc.id)) warnings.push(`skipped ${base}: duplicate id`);
      else docs.set(r.doc.id, r.doc);
    } catch {
      warnings.push(`skipped ${base}: unreadable`);
    }
  }
  return { docs, warnings };
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
    const r = await readDir(dir, source, msg);
    warnings.push(...r.warnings);
    for (const [id, doc] of r.docs) {
      if (all.has(id) || all.size < MAX_DOCS) all.set(id, doc); // replace by id is silent
      else capped = true;
    }
  }
  if (capped) warnings.push(`document limit of ${MAX_DOCS} reached, extra documents ignored`);
  return { docs: [...all.values()], warnings };
};

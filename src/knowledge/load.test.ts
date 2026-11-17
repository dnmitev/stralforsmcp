import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../stralfors/errors.ts';
import { loadKnowledge } from './load.ts';

let root: string;
let pub: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kn-'));
  pub = join(root, 'pub');
  await mkdir(pub);
});
afterEach(() => rm(root, { recursive: true, force: true }));

const md = (id: string, extra: Record<string, string> = {}, body = 'Body') => {
  const fields = { id, title: `Title ${id}`, ...extra };
  return `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;
};
const put = async (dir: string, name: string, content: string) => {
  await mkdir(join(dir, name, '..'), { recursive: true });
  await writeFile(join(dir, name), content);
};
const overlay = async (name: string) => {
  const d = join(root, name);
  await mkdir(d);
  return d;
};
const ids = (docs: { id: string }[]) => docs.map((d) => d.id).sort();

describe('public directory', () => {
  it('loads valid .md files recursively as source public', async () => {
    await put(pub, 'a.md', md('a', { source: 'private' }));
    await put(pub, 'sub/deep/b.md', md('b'));
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [] });
    expect(ids(r.docs)).toEqual(['a', 'b']);
    expect(r.docs.every((d) => d.source === 'public')).toBe(true);
    expect(r.warnings).toEqual([]);
  });
  it('ignores non-.md files without a warning', async () => {
    await put(pub, 'a.md', md('a'));
    await put(pub, 'notes.txt', md('t'));
    await put(pub, 'b.md.bak', md('u'));
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [] });
    expect(ids(r.docs)).toEqual(['a']);
    expect(r.warnings).toEqual([]);
  });
  it('skips invalid files with a fixed warning naming the base name only', async () => {
    await put(pub, 'ok.md', md('ok'));
    await put(pub, 'secretdir/bad-one.md', '---\nid: x\n---\nSECRET-BODY-MARKER');
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [] });
    expect(ids(r.docs)).toEqual(['ok']);
    expect(r.warnings).toHaveLength(1);
    const w = r.warnings[0] as string;
    expect(w).toContain('bad-one.md');
    expect(w).not.toContain('secretdir');
    expect(w).not.toContain(root);
    expect(w).not.toContain('SECRET-BODY-MARKER');
  });
  it('skips a doc whose body is over the cap', async () => {
    await put(pub, 'big.md', md('big', {}, 'x'.repeat(20001)));
    await put(pub, 'edge.md', md('edge', {}, 'x'.repeat(20000)));
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [] });
    expect(ids(r.docs)).toEqual(['edge']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('big.md');
  });
  it('skips a duplicate id inside one directory with a warning', async () => {
    await put(pub, 'one.md', md('same'));
    await put(pub, 'two.md', md('same'));
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [] });
    expect(r.docs).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).not.toContain(root);
  });
});

describe('size caps', () => {
  // body is capped at 20000 chars, so pad with a long link to reach an exact byte size
  const sized = (id: string, bytes: number) => {
    const head = (link: string) => md(id, { link }, '€'.repeat(20000));
    const base = Buffer.byteLength(head('https://x.test/'));
    return head('https://x.test/' + 'a'.repeat(bytes - base));
  };
  it('loads a file of exactly 64 KiB and ignores one byte more', async () => {
    const exact = sized('exact', 65536);
    const over = sized('over', 65537);
    expect(Buffer.byteLength(exact)).toBe(65536);
    expect(Buffer.byteLength(over)).toBe(65537);
    await put(pub, 'exact.md', exact);
    await put(pub, 'over.md', over);
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [] });
    expect(ids(r.docs)).toEqual(['exact']);
  });
  it('keeps at most 500 docs in total', async () => {
    for (let i = 0; i < 501; i++) await put(pub, `d${i}.md`, md(`d${i}`));
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [] });
    expect(r.docs).toHaveLength(500);
  });
  it('at the cap an overlay still replaces an admitted id, and new ids are refused with one warning', async () => {
    for (let i = 0; i < 500; i++) await put(pub, `d${i}.md`, md(`d${i}`));
    const o = await overlay('o');
    await put(o, 'a-extra.md', md('extra'));
    await put(o, 'z-replace.md', md('d499', { title: 'Replaced' }));
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [o] });
    expect(r.docs).toHaveLength(500);
    expect(r.docs.find((d) => d.id === 'd499')?.source).toBe('private');
    expect(r.docs.some((d) => d.id === 'extra')).toBe(false);
    expect(r.warnings.filter((w) => w.startsWith('document limit'))).toHaveLength(1);
  });
  it('keeps all docs when exactly 500', async () => {
    for (let i = 0; i < 500; i++) await put(pub, `d${i}.md`, md(`d${i}`));
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [] });
    expect(r.docs).toHaveLength(500);
  });
});

describe('symlink escape', () => {
  it('ignores a file symlink and a directory symlink that resolve outside the directory', async () => {
    const outside = await overlay('outside');
    await put(outside, 'evil.md', md('evil'));
    await put(outside, 'nested/evil2.md', md('evil2'));
    await put(pub, 'ok.md', md('ok'));
    await symlink(join(outside, 'evil.md'), join(pub, 'link.md'));
    await symlink(outside, join(pub, 'linkdir'));
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [] });
    expect(ids(r.docs)).toEqual(['ok']);
    for (const w of r.warnings) expect(w).not.toContain(root);
  });
});

describe('private overlay', () => {
  it('empty overlayDirs returns only public docs', async () => {
    await put(pub, 'a.md', md('a'));
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [] });
    expect(r.docs.map((d) => d.source)).toEqual(['public']);
  });
  it('loads overlay docs as private regardless of front matter', async () => {
    await put(pub, 'a.md', md('a'));
    const o = await overlay('o1');
    await put(o, 'p.md', md('p', { source: 'public' }));
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [o] });
    expect(r.docs.find((d) => d.id === 'p')?.source).toBe('private');
    expect(r.docs.find((d) => d.id === 'a')?.source).toBe('public');
  });
  it('a private doc replaces a public doc with the same id', async () => {
    await put(pub, 'a.md', md('a', { title: 'Public title' }));
    const o = await overlay('o1');
    await put(o, 'x.md', md('a', { title: 'Private title' }));
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [o] });
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0]).toMatchObject({ id: 'a', title: 'Private title', source: 'private' });
  });
  it('a later overlay directory replaces an earlier one', async () => {
    const o1 = await overlay('o1');
    const o2 = await overlay('o2');
    await put(o1, 'a.md', md('a', { title: 'First' }));
    await put(o2, 'a.md', md('a', { title: 'Second' }));
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [o1, o2] });
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0]?.title).toBe('Second');
  });
  it('overlay problems are warned by base name only', async () => {
    const o = await overlay('o1');
    await put(o, 'deep/broken.md', '---\nid: Bad Id\ntitle: t\n---\nPRIVATE-CONTENT');
    const r = await loadKnowledge({ publicDir: pub, overlayDirs: [o] });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('broken.md');
    expect(r.warnings[0]).not.toContain('PRIVATE-CONTENT');
    expect(r.warnings[0]).not.toContain(root);
  });
  it('a missing overlay directory is a ConfigError with fixed text and no path', async () => {
    const missing = join(root, 'does-not-exist');
    const err = await loadKnowledge({ publicDir: pub, overlayDirs: [missing] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe('KNOWLEDGE_DIRS is not readable');
    expect((err as Error).message).not.toContain('does-not-exist');
  });
  it('an overlay path that is a file is a ConfigError too', async () => {
    await put(root, 'afile', 'x');
    await expect(loadKnowledge({ publicDir: pub, overlayDirs: [join(root, 'afile')] })).rejects.toThrow(
      'KNOWLEDGE_DIRS is not readable',
    );
  });
  it('fails closed when any one of several overlay directories is missing', async () => {
    const o = await overlay('o1');
    await expect(
      loadKnowledge({ publicDir: pub, overlayDirs: [o, join(root, 'nope')] }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

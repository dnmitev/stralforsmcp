// Loader TOCTOU (plan 04-02, AC-7): the file is read through one opened handle with a bounded read, so a file
// that grew after the size check is still caught. The seam is a wrapped fs `open` whose handle reports a stale size.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => ({ calls: 0, staleSize: undefined as number | undefined }));
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      opened.calls++;
      const fh = await actual.open(...args);
      if (opened.staleSize === undefined) return fh;
      const size = opened.staleSize;
      return new Proxy(fh, {
        get: (t, k) => {
          if (k === 'stat') return async () => Object.assign(Object.create(await t.stat()) as object, { size });
          const v = Reflect.get(t, k) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    },
  };
});
const { loadKnowledge } = await import('./load.ts');

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kn-race-'));
  await mkdir(join(root, 'pub'));
  opened.calls = 0;
  opened.staleSize = undefined;
});
afterEach(() => rm(root, { recursive: true, force: true }));

const doc = (id: string, bodyBytes: number) => `---\nid: ${id}\ntitle: T ${id}\n---\n${'x'.repeat(bodyBytes)}\n`;

describe('file grown between the size check and the read', () => {
  it('reads through an opened handle at all', async () => {
    await writeFile(join(root, 'pub', 'a.md'), doc('a', 10));
    const r = await loadKnowledge({ publicDir: join(root, 'pub'), overlayDirs: [] });
    expect(r.docs.map((d) => d.id)).toEqual(['a']);
    expect(opened.calls).toBeGreaterThan(0);
  });
  it('a file that now holds more than 64 KiB although the handle reported a small size is skipped as too large', async () => {
    await writeFile(join(root, 'pub', 'grown.md'), doc('grown', 70000));
    opened.staleSize = 100;
    const r = await loadKnowledge({ publicDir: join(root, 'pub'), overlayDirs: [] });
    expect(r.docs).toEqual([]);
    expect(r.warnings).toEqual([{ source: 'public', text: 'skipped grown.md: file too large' }]);
  });
  it('a file of exactly 64 KiB with a stale small size is still loaded (boundary pair)', async () => {
    const head = `---\nid: edge\ntitle: T\nlink: https://x.test/`;
    const tail = `\n---\nbody\n`;
    const text = head + 'a'.repeat(65536 - Buffer.byteLength(head + tail)) + tail;
    expect(Buffer.byteLength(text)).toBe(65536);
    await writeFile(join(root, 'pub', 'edge.md'), text);
    opened.staleSize = 100;
    expect((await loadKnowledge({ publicDir: join(root, 'pub'), overlayDirs: [] })).docs.map((d) => d.id)).toEqual(['edge']);
  });
  it('a file one byte over 64 KiB with a stale small size is skipped', async () => {
    const head = `---\nid: edge\ntitle: T\nlink: https://x.test/`;
    const tail = `\n---\nbody\n`;
    const text = head + 'a'.repeat(65537 - Buffer.byteLength(head + tail)) + tail;
    expect(Buffer.byteLength(text)).toBe(65537);
    await writeFile(join(root, 'pub', 'edge.md'), text);
    opened.staleSize = 100;
    const r = await loadKnowledge({ publicDir: join(root, 'pub'), overlayDirs: [] });
    expect(r.docs).toEqual([]);
    expect(r.warnings.map((w) => w.text)).toEqual(['skipped edge.md: file too large']);
  });
});

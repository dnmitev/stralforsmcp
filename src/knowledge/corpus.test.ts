import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadKnowledge } from './load.ts';

const publicDir = join(import.meta.dirname, '../../knowledge/public');

describe('shipped public corpus (AC-2)', async () => {
  const { docs, warnings } = await loadKnowledge({ publicDir, overlayDirs: [] });
  it('has 6 to 8 files and every one parses with zero warnings', () => {
    const files = readdirSync(publicDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files.length).toBeLessThanOrEqual(8);
    expect(warnings).toEqual([]);
    expect(docs).toHaveLength(files.length);
  });
  it('ids are unique', () => expect(new Set(docs.map((d) => d.id)).size).toBe(docs.length));
  it('every doc is public, links to the https vendor docs and has a body of at most 4000 characters', () => {
    for (const d of docs) {
      expect(d.source, d.id).toBe('public');
      expect(d.link, d.id).toMatch(/^https:\/\/(test\.)?developer\.stralfors\.com\/docs/);
      expect(d.body.length, d.id).toBeGreaterThan(0);
      expect(d.body.length, d.id).toBeLessThanOrEqual(4000);
    }
  });
});

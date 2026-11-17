import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadKnowledge } from './load.ts';
import { createIndex, search } from './search.ts';
import type { KnowledgeDoc } from './doc.ts';
import * as barrel from './index.ts';

const d = (id: string, o: Partial<KnowledgeDoc> = {}): KnowledgeDoc => ({
  id,
  title: `Title ${id}`,
  source: 'public',
  tags: [],
  body: 'filler',
  ...o,
});
const run = (docs: KnowledgeDoc[], q: Parameters<typeof search>[1]) => search(createIndex(docs), q);
const idsOf = (r: ReturnType<typeof search>) => r.hits.map((h) => h.id);

describe('fixed corpus', async () => {
  const { docs } = await loadKnowledge({ publicDir: join(import.meta.dirname, '../../test/fixtures/knowledge'), overlayDirs: [] });
  const index = createIndex(docs);
  it('loads the synthetic corpus', () => expect(docs.length).toBe(8));
  it('ranks the AvtaleGiro doc first for "avtalegiro mandate" (title+tag beat body-only)', () => {
    const r = search(index, { query: 'avtalegiro mandate' });
    expect(r.hits[0]?.id).toBe('avtalegiro-mandate');
    expect(r.total).toBeGreaterThan(1);
    expect(idsOf(r)).toContain('se-vs-no');
  });
  it('returns hit metadata', () => {
    const h = search(index, { query: 'avtalegiro mandate' }).hits[0];
    expect(h).toMatchObject({
      id: 'avtalegiro-mandate',
      title: 'AvtaleGiro mandate setup',
      source: 'public',
      country: 'NO',
      channel: 'Post',
      link: 'https://docs.example.test/avtalegiro',
    });
    expect(typeof h?.snippet).toBe('string');
    const noMeta = search(index, { query: 'certificate token' }).hits[0];
    expect(noMeta?.id).toBe('auth-basics');
    expect(noMeta?.country).toBeUndefined();
  });
  it('filters by country, channel and source before ranking', () => {
    expect(idsOf(search(index, { query: 'avtalegiro mandate', country: 'SE' }))).toEqual(
      expect.not.arrayContaining(['avtalegiro-mandate', 'tracking-basics']),
    );
    const post = search(index, { query: 'avtalegiro mandate', channel: 'Post' });
    expect(post.hits[0]?.id).toBe('avtalegiro-mandate');
    // se-vs-no has no channel, so it is general and now matches channel=Post (04-02, D5)
    expect(idsOf(post).sort()).toEqual(['avtalegiro-mandate', 'se-vs-no', 'tracking-basics']);
    expect(post.total).toBe(3);
    expect(search(index, { query: 'avtalegiro mandate', source: 'private' })).toEqual({ hits: [], total: 0 });
    expect(search(index, { query: 'avtalegiro', source: 'public', country: 'NO', channel: 'Post' }).total).toBe(3);
  });
  it('country=SE returns the general se-vs-no doc and never a NO doc; a SE doc still ranks as before', () => {
    const r = search(index, { query: 'country differences', country: 'SE' });
    expect(idsOf(r)).toContain('se-vs-no');
    const none = search(index, { query: 'avtalegiro mandate', country: 'SE' });
    expect(idsOf(none)).not.toContain('avtalegiro-mandate');
    expect(idsOf(none)).not.toContain('tracking-basics');
    expect(search(index, { query: 'validate dry run', country: 'SE' }).hits[0]?.id).toBe('validate-dry-run');
  });
  it('matches Unicode letters, case-insensitively', () => {
    expect(search(index, { query: 'FAKTURARÄKNING' }).hits[0]?.id).toBe('unicode-fakturaraekning');
    expect(search(index, { query: 'förfallodatum' }).hits[0]?.id).toBe('unicode-fakturaraekning');
    expect(search(index, { query: 'betalningspåminnelse' }).hits[0]?.id).toBe('unicode-fakturaraekning');
  });
});

describe('query handling', () => {
  const docs = [d('a', { body: 'the and a is mandate' })];
  it.each([[''], ['   '], ['the and a is'], ['!!! ---']])('%j returns no hits', (query) => {
    expect(run(docs, { query })).toEqual({ hits: [], total: 0 });
  });
  it('drops stop words but keeps the real terms', () => {
    expect(idsOf(run(docs, { query: 'the mandate' }))).toEqual(['a']);
  });
  it('returns nothing when no term matches', () => {
    expect(run(docs, { query: 'zzzz' })).toEqual({ hits: [], total: 0 });
  });
  it('splits on non-alphanumerics', () => {
    expect(idsOf(run([d('a', { body: 'avtale-giro' })], { query: 'avtale giro' }))).toEqual(['a']);
    expect(idsOf(run([d('a', { body: 'avtale-giro' })], { query: 'giro' }))).toEqual(['a']);
  });
  it('uses at most 12 query terms', () => {
    const terms = Array.from({ length: 13 }, (_, i) => `term${String.fromCharCode(97 + i)}`);
    const only13th = [d('a', { body: terms[12] as string })];
    expect(run(only13th, { query: terms.join(' ') }).total).toBe(0);
    const only12th = [d('a', { body: terms[11] as string })];
    expect(run(only12th, { query: terms.join(' ') }).total).toBe(1);
  });
});

describe('ranking', () => {
  it('weights title over tags over body', () => {
    // equal token counts, so only the field weights differ; ids sort opposite to the expected ranking, so the id tie-break cannot pass this
    const docs = [
      d('a-body', { title: 'alpha beta', body: 'zebra' }),
      d('b-tag', { title: 'alpha beta', tags: ['zebra'], body: '' }),
      d('c-title', { title: 'zebra beta', body: 'alpha' }),
    ];
    expect(idsOf(run(docs, { query: 'zebra' }))).toEqual(['c-title', 'b-tag', 'a-body']);
  });
  it('title outranks several body mentions', () => {
    const docs = [d('a-body', { body: 'zebra zebra zebra zebra' }), d('z-title', { title: 'zebra' })];
    expect(idsOf(run(docs, { query: 'zebra' }))[0]).toBe('z-title');
  });
  it('breaks ties by id', () => {
    const docs = ['c', 'a', 'b'].map((id) => d(id, { title: 'same', body: 'same body' }));
    expect(idsOf(run(docs, { query: 'same' }))).toEqual(['a', 'b', 'c']);
  });
  it('prefers a shorter doc for the same term frequency (length normalisation)', () => {
    const docs = [
      d('a-long', { body: `quokka ${'pad '.repeat(300)}` }),
      d('z-short', { body: 'quokka' }),
    ];
    expect(idsOf(run(docs, { query: 'quokka' }))[0]).toBe('z-short');
  });
  it('prefers a rarer term over a common one', () => {
    const common = Array.from({ length: 6 }, (_, i) => d(`c${i}`, { body: 'common' }));
    const docs = [...common, d('a-common-only', { body: 'common' }), d('z-rare', { body: 'rareword' })];
    expect(idsOf(run(docs, { query: 'common rareword' }))[0]).toBe('z-rare');
  });
  it('ranks a doc matching more query terms higher', () => {
    const docs = [d('a-one', { body: 'alpha' }), d('z-two', { body: 'alpha beta' })];
    expect(idsOf(run(docs, { query: 'alpha beta' }))[0]).toBe('z-two');
  });
});

describe('filters', () => {
  const docs = [
    d('se-print', { country: 'SE', channel: 'Print', body: 'topic' }),
    d('no-post', { country: 'NO', channel: 'Post', body: 'topic' }),
    d('priv', { country: 'SE', channel: 'Post', source: 'private', body: 'topic' }),
    d('none', { body: 'topic' }),
  ];
  it('each filter narrows alone and combined; docs without the field count as general and match any filter value', () => {
    expect(idsOf(run(docs, { query: 'topic', country: 'SE' })).sort()).toEqual(['none', 'priv', 'se-print']);
    expect(idsOf(run(docs, { query: 'topic', channel: 'Post' })).sort()).toEqual(['no-post', 'none', 'priv']);
    expect(idsOf(run(docs, { query: 'topic', source: 'private' }))).toEqual(['priv']);
    expect(idsOf(run(docs, { query: 'topic', country: 'SE', channel: 'Post' })).sort()).toEqual(['none', 'priv']);
    expect(run(docs, { query: 'topic', country: 'DK' })).toEqual({ hits: [{ id: 'none', title: 'Title none', source: 'public', snippet: 'topic' }], total: 1 });
  });
  it('country and channel are judged independently: a general country with another channel is excluded', () => {
    const mixed = [d('c-only', { channel: 'Print', body: 'topic' }), d('k-only', { country: 'SE', body: 'topic' })];
    expect(idsOf(run(mixed, { query: 'topic', country: 'SE', channel: 'Print' })).sort()).toEqual(['c-only', 'k-only']);
    expect(idsOf(run(mixed, { query: 'topic', country: 'NO', channel: 'Print' }))).toEqual(['c-only']);
    expect(idsOf(run(mixed, { query: 'topic', country: 'SE', channel: 'Post' }))).toEqual(['k-only']);
    expect(run(mixed, { query: 'topic', country: 'NO', channel: 'Post' })).toEqual({ hits: [], total: 0 });
  });
  it('a general doc is returned for a filter but a doc of another value is not, and ranking is unchanged', () => {
    const rank = [d('a-general', { body: 'topic' }), d('b-se', { country: 'SE', title: 'topic topic', body: 'topic' }), d('c-no', { country: 'NO', title: 'topic topic' })];
    expect(idsOf(run(rank, { query: 'topic', country: 'SE' }))).toEqual(['b-se', 'a-general']);
    expect(idsOf(run(rank, { query: 'topic' }))).toEqual(['b-se', 'c-no', 'a-general']);
  });
  it('filters apply before the limit', () => {
    const many = [
      ...Array.from({ length: 8 }, (_, i) => d(`a${i}`, { country: 'SE', title: 'topic topic' })),
      d('z-no', { country: 'NO', body: 'topic' }),
    ];
    expect(idsOf(run(many, { query: 'topic', country: 'NO', limit: 1 }))).toEqual(['z-no']);
  });
  it('a filter alone with an empty query returns nothing', () => {
    expect(run(docs, { query: '', country: 'SE' })).toEqual({ hits: [], total: 0 });
  });
});

describe('limit', () => {
  const docs = Array.from({ length: 12 }, (_, i) => d(`d${String(i).padStart(2, '0')}`, { body: 'topic' }));
  it.each([
    [undefined, 5],
    [1, 1],
    [3, 3],
    [10, 10],
    [11, 10],
    [100, 10],
  ])('limit %s gives %i hits and total counts all matches', (limit, n) => {
    const r = run(docs, { query: 'topic', ...(limit === undefined ? {} : { limit }) });
    expect(r.hits).toHaveLength(n);
    expect(r.total).toBe(12);
  });
  it('returns fewer hits than the limit when fewer match', () => {
    expect(run(docs.slice(0, 2), { query: 'topic', limit: 10 }).hits).toHaveLength(2);
  });
});

describe('snippet', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  it('is at most 240 chars but uses most of that budget', () => {
    const body = `${words(300)} needle ${words(300)}`;
    const s = run([d('a', { body })], { query: 'needle' }).hits[0]?.snippet ?? '';
    expect(s.length).toBeLessThanOrEqual(240);
    expect(s.length).toBeGreaterThan(200);
    expect(s).toContain('needle');
  });
  it('is a window around the first matching term, even when it sits late in the body', () => {
    const body = `${'x'.repeat(5)} ${words(500)} needle`;
    expect(run([d('a', { body })], { query: 'needle' }).hits[0]?.snippet).toContain('needle');
  });
  it('collapses whitespace', () => {
    const body = 'first   line\n\n\tsecond    needle \r\n  third';
    const s = run([d('a', { body })], { query: 'needle' }).hits[0]?.snippet ?? '';
    expect(s).not.toMatch(/\s{2}|[\n\t\r]/);
    expect(s).toContain('first line second needle third');
  });
  it('returns a short body whole', () => {
    expect(run([d('a', { body: 'short needle body' })], { query: 'needle' }).hits[0]?.snippet).toBe('short needle body');
  });
  it('is bounded for a long title-only match too', () => {
    const s = run([d('a', { title: 'needle', body: words(500) })], { query: 'needle' }).hits[0]?.snippet ?? '';
    expect(s.length).toBeLessThanOrEqual(240);
  });
});

describe('snippet and surrogate pairs', () => {
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const snip = (body: string) => run([d('a', { body })], { query: 'needle' }).hits[0]?.snippet ?? '';
  it('a window that starts inside an emoji never begins with a lone low surrogate', () => {
    // match at index 300, window start 240: the emoji occupies 239 and 240
    const body = `${'a'.repeat(239)}\u{1F600}${'b'.repeat(58)} needle ${'c'.repeat(400)}`;
    expect(body.indexOf('needle')).toBe(300);
    const s = snip(body);
    expect(s).toContain('needle');
    expect(s).not.toMatch(LONE);
    expect(s.length).toBeLessThanOrEqual(240);
  });
  it('a window that ends inside an emoji never ends with a lone high surrogate', () => {
    // match at 0, window 0..240: the emoji occupies 239 and 240
    const body = `needle ${'x'.repeat(232)}\u{1F600}${'y'.repeat(300)}`;
    expect(body.charCodeAt(239)).toBeGreaterThanOrEqual(0xd800);
    const s = snip(body);
    expect(s).toContain('needle');
    expect(s).not.toMatch(LONE);
    expect(s.length).toBeLessThanOrEqual(240);
  });
  it('a whole emoji inside the window is kept', () => {
    expect(snip(`needle \u{1F600} ${'z'.repeat(400)}`)).toContain('\u{1F600}');
  });
});

describe('index.ts barrel', () => {
  it('re-exports the public API', () => {
    expect(barrel.parseDoc).toBeTypeOf('function');
    expect(barrel.loadKnowledge).toBeTypeOf('function');
    expect(barrel.createIndex).toBeTypeOf('function');
    expect(barrel.search).toBeTypeOf('function');
  });
});

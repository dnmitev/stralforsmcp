import type { KnowledgeDoc } from './doc.ts';

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'it', 'this', 'that']);
const K1 = 1.2;
const B = 0.75;
const MAX_TERMS = 12;
const SNIPPET = 240;

const tokenize = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOP.has(t));

type Entry = { doc: KnowledgeDoc; tf: Map<string, number>; len: number; flat: string };
export type Index = { entries: Entry[]; df: Map<string, number>; avg: number };

export type Hit = Pick<KnowledgeDoc, 'id' | 'title' | 'source' | 'country' | 'channel' | 'link'> & { snippet: string };
export type SearchResult = { hits: Hit[]; total: number };
export type SearchQuery = { query: string; country?: string; channel?: string; source?: 'public' | 'private'; limit?: number };

export const createIndex = (docs: KnowledgeDoc[]): Index => {
  const df = new Map<string, number>();
  const entries = docs.map((doc) => {
    const tf = new Map<string, number>();
    const add = (text: string, w: number) => {
      for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + w);
    };
    add(doc.title, 4);
    add(doc.tags.join(' '), 3);
    add(doc.body, 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const len = tokenize(`${doc.title} ${doc.tags.join(' ')} ${doc.body}`).length;
    return { doc, tf, len, flat: doc.body.replace(/\s+/g, ' ').trim() };
  });
  return { entries, df, avg: entries.reduce((n, e) => n + e.len, 0) / (entries.length || 1) };
};

const snippet = (flat: string, terms: Set<string>) => {
  if (flat.length <= SNIPPET) return flat;
  let at = 0;
  for (const m of flat.matchAll(/[\p{L}\p{N}]+/gu))
    if (terms.has(m[0].toLowerCase())) {
      at = m.index;
      break;
    }
  const start = Math.max(0, Math.min(at - 60, flat.length - SNIPPET));
  return flat.slice(start, start + SNIPPET);
};

// ponytail: linear scan of at most a few hundred docs; move to a real engine only past a few thousand.
export const search = (index: Index, q: SearchQuery): SearchResult => {
  const terms = [...new Set(tokenize(q.query))].slice(0, MAX_TERMS);
  const termSet = new Set(terms);
  const n = index.entries.length;
  const scored: { e: Entry; score: number }[] = [];
  for (const e of index.entries) {
    const d = e.doc;
    if ((q.country && d.country !== q.country) || (q.channel && d.channel !== q.channel) || (q.source && d.source !== q.source)) continue;
    let score = 0;
    for (const t of terms) {
      const f = e.tf.get(t);
      if (!f) continue;
      const df = index.df.get(t) as number;
      score += Math.log(1 + (n - df + 0.5) / (df + 0.5)) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * e.len) / index.avg)));
    }
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.e.doc.id < b.e.doc.id ? -1 : 1));
  const limit = Math.min(10, Math.max(1, q.limit ?? 5));
  const hits = scored.slice(0, limit).map(({ e: { doc, flat } }) => ({
    id: doc.id,
    title: doc.title,
    source: doc.source,
    ...(doc.country && { country: doc.country }),
    ...(doc.channel && { channel: doc.channel }),
    ...(doc.link && { link: doc.link }),
    snippet: snippet(flat, termSet),
  }));
  return { hits, total: scored.length };
};

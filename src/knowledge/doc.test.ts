import { describe, expect, it } from 'vitest';
import { knowledgeDoc, parseDoc } from './doc.ts';

const raw = (fields: Record<string, string> = {}, body = 'Body text.') => {
  const all = { id: 'doc-1', title: 'A title', ...fields };
  const lines = Object.entries(all).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
};
const ok = (r: string, source: 'public' | 'private' = 'public') => parseDoc(r, source).ok;

describe('parseDoc valid input', () => {
  it('parses all fields into a typed doc', () => {
    const r = parseDoc(
      raw({ country: 'SE', channel: 'Print', tags: 'a, b', link: 'https://docs.example.test/x:y' }, 'Hello body'),
      'public',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc).toMatchObject({
      id: 'doc-1',
      title: 'A title',
      source: 'public',
      country: 'SE',
      channel: 'Print',
      tags: ['a', 'b'],
      link: 'https://docs.example.test/x:y',
    });
    expect(r.doc.body).toContain('Hello body');
  });
  it('defaults tags to an empty array and leaves optionals undefined', () => {
    const r = parseDoc(raw(), 'private');
    if (!r.ok) throw new Error('expected ok');
    expect(r.doc.tags).toEqual([]);
    expect(r.doc.country).toBeUndefined();
    expect(r.doc.channel).toBeUndefined();
    expect(r.doc.link).toBeUndefined();
    expect(r.doc.source).toBe('private');
  });
  it('the source argument wins over a source key in the front matter', () => {
    const r = parseDoc(raw({ source: 'public' }), 'private');
    if (!r.ok) throw new Error('expected ok');
    expect(r.doc.source).toBe('private');
    expect(ok(raw({ source: 'bogus' }), 'public')).toBe(true);
  });
  it('splits a value on the first colon only and trims whitespace', () => {
    const r = parseDoc('---\nid:   spaced  \ntitle:  Title: with colon \n---\nb', 'public');
    if (!r.ok) throw new Error('expected ok');
    expect(r.doc.id).toBe('spaced');
    expect(r.doc.title).toBe('Title: with colon');
  });
});

describe('parseDoc rejects', () => {
  it.each([
    ['no front matter', 'just a body'],
    ['unterminated front matter', '---\nid: a\ntitle: t\nbody'],
    ['empty input', ''],
    ['missing id', '---\ntitle: t\n---\nb'],
    ['missing title', '---\nid: a\n---\nb'],
  ])('%s', (_n, r) => {
    expect(parseDoc(r, 'public')).toEqual({ ok: false });
  });
});

describe('field boundaries', () => {
  it('id: 64 chars ok, 65 fails, pattern enforced', () => {
    expect(ok(raw({ id: 'a'.repeat(64) }))).toBe(true);
    expect(ok(raw({ id: 'a'.repeat(65) }))).toBe(false);
    expect(ok(raw({ id: '0-a' }))).toBe(true);
    for (const bad of ['Upper', '-lead', 'under_score', 'sp ace']) expect(ok(raw({ id: bad }))).toBe(false);
  });
  it('title: 1..120 chars', () => {
    expect(ok(raw({ title: 't'.repeat(120) }))).toBe(true);
    expect(ok(raw({ title: 't'.repeat(121) }))).toBe(false);
    expect(ok(raw({ title: '' }))).toBe(false);
  });
  it('country: exactly two upper-case letters', () => {
    expect(ok(raw({ country: 'NO' }))).toBe(true);
    for (const bad of ['no', 'NOR', 'N', 'N1']) expect(ok(raw({ country: bad }))).toBe(false);
  });
  it('channel: 1..40 alphanumerics', () => {
    expect(ok(raw({ channel: 'a'.repeat(40) }))).toBe(true);
    expect(ok(raw({ channel: 'a'.repeat(41) }))).toBe(false);
    expect(ok(raw({ channel: 'a-b' }))).toBe(false);
    expect(ok(raw({ channel: 'a b' }))).toBe(false);
  });
  it('tags: 12 ok, 13 fail; each tag 32 ok, 33 fail', () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`).join(', ');
    expect(ok(raw({ tags: tags(12) }))).toBe(true);
    expect(ok(raw({ tags: tags(13) }))).toBe(false);
    expect(ok(raw({ tags: 'x'.repeat(32) }))).toBe(true);
    expect(ok(raw({ tags: 'x'.repeat(33) }))).toBe(false);
  });
  it('link: https only and must be a URL', () => {
    expect(ok(raw({ link: 'https://docs.example.test/a' }))).toBe(true);
    for (const bad of ['http://docs.example.test/a', 'ftp://x.test/a', 'javascript:alert(1)', 'not a url'])
      expect(ok(raw({ link: bad }))).toBe(false);
  });
  it('body: 20000 chars ok, 20001 fails', () => {
    expect(ok(raw({}, 'x'.repeat(20000)))).toBe(true);
    expect(ok(raw({}, 'x'.repeat(20001)))).toBe(false);
  });
});

describe('knowledgeDoc schema', () => {
  it('validates a doc object and rejects a bad source', () => {
    const base = { id: 'a', title: 't', source: 'public', tags: [], body: 'b' };
    expect(knowledgeDoc.safeParse(base).success).toBe(true);
    expect(knowledgeDoc.safeParse({ ...base, source: 'other' }).success).toBe(false);
    expect(knowledgeDoc.safeParse({ ...base, tags: Array(13).fill('t') }).success).toBe(false);
  });
});

describe('front matter keys cannot touch the prototype', () => {
  // Regression guards: the current parser already ignores these keys; the tests pin that through the Map rewrite (04-02).
  it.each(['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty'])('a %s key is ignored and the doc still parses', (key) => {
    const r = parseDoc(raw({ [key]: 'polluted' }), 'public');
    if (!r.ok) throw new Error('expected ok');
    expect(r.doc).toMatchObject({ id: 'doc-1', title: 'A title', tags: [] });
    expect(Object.getPrototypeOf(r.doc)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)[key === '__proto__' ? 'polluted' : key]).not.toBe('polluted');
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });
  it('a key named like a doc field with a prototype-ish value does not become a field', () => {
    const r = parseDoc('---\nid: a\ntitle: t\n__proto__: {"country":"SE"}\nconstructor: {"channel":"X"}\n---\nb', 'public');
    if (!r.ok) throw new Error('expected ok');
    expect(r.doc.country).toBeUndefined();
    expect(r.doc.channel).toBeUndefined();
  });
  it('a doc with no id still fails when only prototype keys are present', () => {
    expect(ok('---\n__proto__: x\nconstructor: y\ntitle: t\n---\nb')).toBe(false);
    expect(({} as { id?: string }).id).toBeUndefined();
  });
});

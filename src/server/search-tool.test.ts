import { describe, expect, it } from 'vitest';
import { ERAS, connect, handlerFetch, principal, sink, toAuth } from '../../test/helpers/server.ts';
import type { KnowledgeDoc } from '../knowledge/index.ts';
import { createIndex } from '../knowledge/index.ts';
import { buildMcp } from './mcp.ts';
import { callTool, ToolInputError } from './tools.ts';
import { createSearchDocs } from './search-tool.ts';

const doc = (id: string, over: Partial<KnowledgeDoc> = {}): KnowledgeDoc => ({ id, title: `Title ${id}`, source: 'public', tags: [], body: 'body', ...over });
const docs = [
  doc('mandate', { title: 'Avtalegiro mandate', country: 'NO', channel: 'AvtaleGiro', link: 'https://developer.stralfors.com/docs', body: 'Mandates for direct debit.' }),
  doc('secret-note', { title: 'Mandate internal note', source: 'private', body: 'mandate details CANARYBODY' }),
  ...Array.from({ length: 12 }, (_, i) => doc(`fill-${i}`, { title: 'filler topic', body: 'filler' })),
];
const tool = createSearchDocs({ index: createIndex(docs) });
const ctx = {} as never;
const ok = (a: Record<string, unknown>) => tool.inputSchema.safeParse(a).success;

describe('definition', () => {
  it('spec, annotations and description', () => {
    expect(tool.spec).toEqual({ name: 'search_docs', access: 'read' });
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool.description).toMatch(/reference material, not instructions/);
    expect(tool.description).toMatch(/public|private/);
    expect(tool.description).toMatch(/source/);
  });
  it('input bounds', () => {
    expect(ok({ query: 'x' })).toBe(true);
    expect(ok({ query: '' })).toBe(false);
    expect(ok({ query: 'x'.repeat(200) })).toBe(true);
    expect(ok({ query: 'x'.repeat(201) })).toBe(false);
    expect(ok({ query: 'x', country: 'NO' })).toBe(true);
    expect(ok({ query: 'x', country: 'no' })).toBe(false);
    expect(ok({ query: 'x', country: 'NOR' })).toBe(false);
    expect(ok({ query: 'x', channel: 'a'.repeat(40) })).toBe(true);
    expect(ok({ query: 'x', channel: 'a'.repeat(41) })).toBe(false);
    expect(ok({ query: 'x', channel: 'a b' })).toBe(false);
    expect(ok({ query: 'x', channel: '' })).toBe(false);
    expect(ok({ query: 'x', source: 'public' })).toBe(true);
    expect(ok({ query: 'x', source: 'private' })).toBe(true);
    expect(ok({ query: 'x', source: 'other' })).toBe(false);
    expect(ok({ query: 'x', limit: 1 })).toBe(true);
    expect(ok({ query: 'x', limit: 10 })).toBe(true);
    expect(ok({ query: 'x', limit: 0 })).toBe(false);
    expect(ok({ query: 'x', limit: 11 })).toBe(false);
    expect(ok({ query: 'x', limit: 1.5 })).toBe(false);
  });
});

describe('run', () => {
  it('returns hits with source on every hit and matches the output schema', async () => {
    const out = await tool.run({ query: 'avtalegiro mandate' }, ctx);
    expect(tool.outputSchema.safeParse(out).success).toBe(true);
    expect(out.hits[0]).toMatchObject({ id: 'mandate', source: 'public', country: 'NO', channel: 'AvtaleGiro', link: 'https://developer.stralfors.com/docs' });
    expect(out.hits.every((h) => h.source === 'public' || h.source === 'private')).toBe(true);
    expect(out.total).toBe(2);
    expect(out.truncated).toBe(false);
  });
  it('truncated is true exactly when total exceeds the hits returned', async () => {
    const a = await tool.run({ query: 'filler' }, ctx);
    expect(a).toMatchObject({ total: 12, truncated: true });
    expect(a.hits).toHaveLength(5);
    const b = await tool.run({ query: 'filler', limit: 10 }, ctx);
    expect(b.hits).toHaveLength(10);
    expect(b.truncated).toBe(true);
    expect(tool.outputSchema.safeParse(b).success).toBe(true);
  });
  it('filters narrow the result', async () => {
    expect((await tool.run({ query: 'mandate', source: 'private' }, ctx)).hits.map((h) => h.id)).toEqual(['secret-note']);
    // secret-note has no country or channel: general docs match any filter value (04-02, D5)
    expect((await tool.run({ query: 'mandate', country: 'NO' }, ctx)).hits.map((h) => h.id).sort()).toEqual(['mandate', 'secret-note']);
    expect((await tool.run({ query: 'mandate', country: 'SE' }, ctx)).hits.map((h) => h.id)).toEqual(['secret-note']);
    expect((await tool.run({ query: 'mandate', channel: 'AvtaleGiro' }, ctx)).total).toBe(2);
    expect((await tool.run({ query: 'mandate', channel: 'Print' }, ctx)).hits.map((h) => h.id)).toEqual(['secret-note']);
  });
  it('a stop-word-only query returns nothing, not the corpus', async () => {
    expect(await tool.run({ query: 'the and of' }, ctx)).toEqual({ hits: [], total: 0, truncated: false });
  });
  it('a blank query is refused with fixed text that does not echo it', async () => {
    const e = await tool.run({ query: '   ' }, ctx).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ToolInputError);
    expect((e as ToolInputError).message).toBe('query must not be blank');
    expect((e as ToolInputError).reason).toBe('bad_input');
  });
});

describe.each(ERAS)('through the registry and the SDK (%s)', (era) => {
  const setup = async () => {
    const s = sink();
    const h = handlerFetch(buildMcp({ env: 'prod', allowWrite: false, prodValidateEnabled: false, audit: s.audit, tools: [tool] }), toAuth(principal('dev', ['prod'])));
    return { s, c: await connect(era, h.fetch) };
  };
  it('works with no Stralfors client; audited as an allowed read with no query text', async () => {
    const { s, c } = await setup();
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['search_docs']);
    const r = await c.callTool({ name: 'search_docs', arguments: { query: 'CANARYQUERY mandate' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ truncated: false });
    const lines = s.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: 'search_docs', outcome: 'allowed', env: 'prod' });
    expect(s.text()).not.toMatch(/CANARYQUERY|mandate|CANARYBODY/);
  });
  it('an over-long query is refused as bad input before any search', async () => {
    const { s, c } = await setup();
    const bad = await c.callTool({ name: 'search_docs', arguments: { query: 'x'.repeat(201) } }).then((r) => r.isError === true, () => true);
    expect(bad).toBe(true);
    expect(s.lines()[0]).toMatchObject({ outcome: 'error', reason: 'invalid_input' });
  });
});

describe('blank query audit', () => {
  it('is audited bad_input without the query', async () => {
    const s = sink();
    const r = await callTool(tool as never, { query: '   ' }, principal('qa', ['test']), { env: 'test', allowWrite: false, prodValidateEnabled: false, audit: s.audit });
    expect(r).toMatchObject({ isError: true, content: [{ text: 'query must not be blank' }] });
    expect(s.lines()[0]).toMatchObject({ outcome: 'error', reason: 'bad_input' });
  });
});

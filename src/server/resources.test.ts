// Knowledge docs as MCP resources (plan 04-02, AC-1, AC-2, AC-5), driven through buildMcp and the in-process SDK client.
import { describe, expect, it } from 'vitest';
import { ERAS, connect, handlerFetch, principal, sink, toAuth } from '../../test/helpers/server.ts';
import type { KnowledgeDoc } from '../knowledge/index.ts';
import { buildMcp } from './mcp.ts';

const doc = (id: string, over: Partial<KnowledgeDoc> = {}): KnowledgeDoc => ({ id, title: `Title ${id}`, source: 'public', tags: [], body: `Body of ${id}`, ...over });
const docs: KnowledgeDoc[] = [
  doc('mandate', { title: 'Mandate setup', country: 'NO', channel: 'AvtaleGiro', link: 'https://docs.example.test/mandate', body: 'PUBLICBODY mandates explained.' }),
  doc('team-notes', { title: 'Team notes', source: 'private', body: 'PRIVATEBODY internal notes.' }),
  doc('plain'),
];

const setup = async (era: (typeof ERAS)[number], over: { auth?: ReturnType<typeof toAuth> | undefined; knowledge?: { docs: KnowledgeDoc[] } | undefined } = {}) => {
  const s = sink();
  const auth = 'auth' in over ? over.auth : toAuth(principal('pm', ['test']));
  const { fetch } = handlerFetch(buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, audit: s.audit, tools: [], knowledge: 'knowledge' in over ? over.knowledge : { docs } }), auth);
  return { s, c: await connect(era, fetch) };
};
const text = (r: { contents: { uri: string; text?: string; mimeType?: string }[] }) => r.contents.map((x) => x.text ?? '').join('\n');
// A server with no resources either rejects the method or lists nothing; both mean "nothing registered".
const listed = (c: { listResources(): Promise<{ resources: unknown[] }> }) => c.listResources().then((r) => r.resources, () => []);
const fail = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as { message: string; code?: number; data?: unknown });

describe.each(ERAS)('resources (%s)', (era) => {
  it('capabilities advertise resources without listChanged', async () => {
    const { c } = await setup(era);
    const caps = c.getServerCapabilities() as { resources?: Record<string, unknown> };
    expect(caps.resources).toBeDefined();
    expect(caps.resources?.listChanged).toBeFalsy();
  });

  it('resources/list shows the index and every public and private doc with title and source label', async () => {
    const { c } = await setup(era);
    const { resources } = await c.listResources();
    const byUri = new Map(resources.map((r) => [r.uri, r]));
    expect([...byUri.keys()].sort()).toEqual(['knowledge://docs/mandate', 'knowledge://docs/plain', 'knowledge://docs/team-notes', 'knowledge://index']);
    expect(byUri.get('knowledge://docs/team-notes')?.name + ' ' + (byUri.get('knowledge://docs/team-notes')?.title ?? '') + ' ' + (byUri.get('knowledge://docs/team-notes')?.description ?? '')).toMatch(/Team notes/);
    const blob = (u: string) => JSON.stringify(byUri.get(u));
    expect(blob('knowledge://docs/team-notes')).toMatch(/private/);
    expect(blob('knowledge://docs/mandate')).toMatch(/public/);
    expect(blob('knowledge://docs/mandate')).not.toMatch(/PUBLICBODY/);
  });

  it('exposes the doc template', async () => {
    const { c } = await setup(era);
    const { resourceTemplates } = await c.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(['knowledge://docs/{id}']);
  });

  it('reads the index as markdown listing id, title, source, country, channel and no bodies', async () => {
    const { c } = await setup(era);
    const r = await c.readResource({ uri: 'knowledge://index' });
    expect(r.contents[0]?.mimeType).toBe('text/markdown');
    const t = text(r);
    for (const needle of ['mandate', 'Mandate setup', 'team-notes', 'Team notes', 'plain', 'private', 'public', 'NO', 'AvtaleGiro']) expect(t).toContain(needle);
    expect(t).not.toMatch(/PUBLICBODY|PRIVATEBODY|Body of plain/);
  });

  it('reads a public doc: markdown header (title, source, country, channel, link) then the body', async () => {
    const { c } = await setup(era);
    const r = await c.readResource({ uri: 'knowledge://docs/mandate' });
    expect(r.contents).toHaveLength(1);
    expect(r.contents[0]).toMatchObject({ uri: 'knowledge://docs/mandate', mimeType: 'text/markdown' });
    const t = text(r);
    for (const needle of ['Mandate setup', 'public', 'NO', 'AvtaleGiro', 'https://docs.example.test/mandate']) expect(t).toContain(needle);
    expect(t.indexOf('Mandate setup')).toBeLessThan(t.indexOf('PUBLICBODY'));
    expect(t.indexOf('https://docs.example.test/mandate')).toBeLessThan(t.indexOf('PUBLICBODY'));
    expect(t).toContain('PUBLICBODY mandates explained.');
  });

  it('reads a private doc with source private and no link line for a doc without link', async () => {
    const { c } = await setup(era);
    const t = text(await c.readResource({ uri: 'knowledge://docs/team-notes' }));
    expect(t).toContain('Team notes');
    expect(t).toMatch(/private/);
    expect(t).toContain('PRIVATEBODY internal notes.');
    expect(t).not.toMatch(/https?:\/\//);
  });

  it('a read is audited once as an allowed resource:read with no uri and no id', async () => {
    const { c, s } = await setup(era);
    await c.readResource({ uri: 'knowledge://docs/team-notes' });
    const lines = s.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: 'resource:read', outcome: 'allowed', env: 'test' });
    expect(s.text()).not.toMatch(/knowledge:|team-notes|PRIVATEBODY/);
  });

  it.each([['unknown valid id', 'no-such-canary'], ['not a valid doc id', 'Bad_ID-CANARY'], ['path-like id', 'x%2F..CANARY']])('%s: not-found error with fixed text that does not echo the id; audit error/bad_input with no uri', async (_n, id) => {
    const { c, s } = await setup(era);
    const e = await fail(c.readResource({ uri: `knowledge://docs/${id}` }));
    expect(e).toBeDefined();
    expect(e?.code).toBe(-32602); // the SDK maps every resource miss to -32602 and never emits -32002
    expect(JSON.stringify([e?.message, e?.data])).not.toMatch(/CANARY|no-such|knowledge:/);
    const lines = s.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: 'resource:read', outcome: 'error', reason: 'bad_input' });
    expect(lines[0]).not.toHaveProperty('uri');
    expect(s.text()).not.toMatch(/CANARY|no-such|knowledge:/);
  });

  it('the not-found text is the same for an unknown and an invalid id', async () => {
    const { c } = await setup(era);
    const a = await fail(c.readResource({ uri: 'knowledge://docs/no-such-doc' }));
    const b = await fail(c.readResource({ uri: 'knowledge://docs/BAD_ID' }));
    expect(a?.message).toBeTruthy();
    expect(a?.message).toBe(b?.message);
  });

  it('the id regex boundary: 64 chars is looked up, 65 is refused, both as not found', async () => {
    const long = 'a'.repeat(64);
    const { c } = await setup(era, { knowledge: { docs: [...docs, doc(long)] } });
    expect(text(await c.readResource({ uri: `knowledge://docs/${long}` }))).toContain(`Body of ${long}`);
    expect((await fail(c.readResource({ uri: `knowledge://docs/${long}a` })))?.code).toBe(-32602);
  });

  it('without a principal no resources are registered and nothing is audited', async () => {
    const { c, s } = await setup(era, { auth: undefined });
    expect((c.getServerCapabilities() as { resources?: unknown }).resources).toBeUndefined();
    expect(await listed(c)).toEqual([]);
    expect(await fail(c.readResource({ uri: 'knowledge://index' }))).toBeDefined();
    expect(s.lines()).toEqual([]);
  });

  it('authInfo without a principal registers nothing (fail closed)', async () => {
    const { c } = await setup(era, { auth: { token: '', clientId: 'x', scopes: [] } as never });
    expect(await listed(c)).toEqual([]);
  });

  it('with no knowledge in deps nothing is registered', async () => {
    const { c } = await setup(era, { knowledge: undefined });
    expect(await listed(c)).toEqual([]);
  });

  it('an empty doc set still lists the index', async () => {
    const { c } = await setup(era, { knowledge: { docs: [] } });
    expect((await c.listResources()).resources.map((r) => r.uri)).toEqual(['knowledge://index']);
  });

  it('works with the Stralfors client unavailable: no client is ever built by buildMcp (tools empty)', async () => {
    const { c } = await setup(era);
    expect(text(await c.readResource({ uri: 'knowledge://index' }))).toContain('mandate');
  });

  it('exact markdown: doc header, doc without optional fields, and the index lines', async () => {
    const { c } = await setup(era);
    expect(text(await c.readResource({ uri: 'knowledge://docs/mandate' }))).toBe(
      '# Mandate setup\n\n- source: public\n- country: NO\n- channel: AvtaleGiro\n- link: https://docs.example.test/mandate\n\nPUBLICBODY mandates explained.',
    );
    expect(text(await c.readResource({ uri: 'knowledge://docs/plain' }))).toBe('# Title plain\n\n- source: public\n\nBody of plain');
    expect(text(await c.readResource({ uri: 'knowledge://index' }))).toBe(
      '# Knowledge documents\n\n- mandate: Mandate setup (source: public, country: NO, channel: AvtaleGiro)\n- team-notes: Team notes (source: private)\n- plain: Title plain (source: public)',
    );
  });

  it('list and template metadata are described', async () => {
    const { c } = await setup(era);
    const { resources } = await c.listResources();
    const by = new Map(resources.map((r) => [r.uri, r]));
    expect(by.get('knowledge://index')).toMatchObject({ name: 'knowledge-index', title: 'Knowledge index', mimeType: 'text/markdown' });
    expect(by.get('knowledge://index')?.description).toBe('Every knowledge document: id, title, source, country and channel.');
    expect(by.get('knowledge://docs/mandate')).toMatchObject({ name: 'mandate', title: 'Mandate setup', description: 'Mandate setup (source: public)', mimeType: 'text/markdown' });
    const t = (await c.listResourceTemplates()).resourceTemplates[0];
    expect(t).toMatchObject({ name: 'knowledge-doc', title: 'Knowledge document', description: 'One knowledge document by id, as Markdown.', mimeType: 'text/markdown' });
  });

  it('an index read is audited as allowed with no reason; a doc id that is not a string never matches', async () => {
    const { c, s } = await setup(era);
    await c.readResource({ uri: 'knowledge://index' });
    expect(s.lines()).toHaveLength(1);
    expect(s.lines()[0]).toMatchObject({ tool: 'resource:read', outcome: 'allowed', env: 'test', durationMs: 0 });
    expect(s.lines()[0]).not.toHaveProperty('reason');
  });

  it('a regex-valid id that is not in the set is refused even when another doc exists', async () => {
    const { c } = await setup(era);
    expect((await fail(c.readResource({ uri: 'knowledge://docs/plain2' })))?.code).toBe(-32602);
  });
});

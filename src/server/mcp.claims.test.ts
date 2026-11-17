// Claims are derived per request from the caller's AuthInfo, not once per process; absent claims fail closed.
import { describe, expect, it } from 'vitest';
import { buildMcp } from './mcp.ts';
import { ERAS, connect, handlerFetch, mkDef, okTool, principal, sink, toAuth } from '../../test/helpers/server.ts';

const scoped = mkDef('scopedTool', 'read', async () => ({ v: 1 }), 'apiomni.read');
const base = () => ({ env: 'test' as const, allowWrite: true, prodValidateEnabled: false, audit: sink().audit });
const names = async (era: (typeof ERAS)[number], f: typeof fetch) => (await (await connect(era, f)).listTools()).tools.map((t) => t.name);

describe.each(ERAS)('claimsFor (%s)', (era) => {
  it('two callers of one factory see their own scopes', async () => {
    const factory = buildMcp({ ...base(), tools: [okTool, scoped], claimsFor: (a) => ({ hasScope: (s) => (a?.extra?.scopes as string[] | undefined)?.includes(s) ?? false }) });
    const auth = (scopes: string[]) => ({ ...toAuth(principal('qa', ['test'])), extra: { principal: principal('qa', ['test']), scopes } });
    expect(await names(era, handlerFetch(factory, auth(['apiomni.read'])).fetch)).toEqual(['okTool', 'scopedTool']);
    expect(await names(era, handlerFetch(factory, auth([])).fetch)).toEqual(['okTool']);
  });
  it('a caller with no claims fails closed: the scoped tool is hidden, no throw', async () => {
    const factory = buildMcp({ ...base(), tools: [okTool, scoped], claimsFor: () => undefined });
    expect(await names(era, handlerFetch(factory, toAuth(principal('qa', ['test']))).fetch)).toEqual(['okTool']);
  });
});

describe('claimsFor wiring', () => {
  it('a scoped tool without a source still throws at construction', () => {
    expect(() => buildMcp({ ...base(), tools: [scoped] })).toThrow('tool scopedTool needs a scope but claims are not wired');
  });
});

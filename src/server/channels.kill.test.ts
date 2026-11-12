/* R19 kill tests: metadata, constants, argument resolution without any network. */
import { describe, expect, it, vi } from 'vitest';
import { PROFILE_REQUIRED, UNKNOWN_AGREEMENT, UNKNOWN_PROFILE, createListChannels, listChannelsInput, listChannelsOutput } from './channels.ts';
import { ToolInputError, type ToolContext } from './tools.ts';
import type { StralforsClient } from '../stralfors/index.ts';
import { principal } from '../../test/helpers/server.ts';

const ctx = (): ToolContext => ({ principal: principal('dev', ['test']), env: 'test', allowWrite: false, prodValidateEnabled: false, visible: [] });
const mk = () => {
  const a = vi.fn(async (_id?: string) => ['A']);
  const b = vi.fn(async (_id?: string) => ['B']);
  const clients = new Map([['a', { channels: a }], ['b', { channels: b }]]) as unknown as ReadonlyMap<string, StralforsClient>;
  const config = { profiles: { a: { agreements: [{ label: 'x', id: 'id-a' }, { id: 'id-nolabel' }] }, b: { agreements: [{ label: 'x', id: 'id-b' }, { label: 'x', id: 'id-b2' }] } } } as never;
  return { a, b, tool: createListChannels({ clients, config }) };
};

describe('list_channels kill', () => {
  it('metadata', () => {
    const { tool } = mk();
    expect(tool.spec).toEqual({ name: 'list_channels', access: 'read' });
    expect(tool.title).toBe('List channels');
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(tool.inputSchema).toBe(listChannelsInput);
    expect(tool.outputSchema).toBe(listChannelsOutput);
    expect(tool.description.length).toBeGreaterThan(0);
    expect(`${tool.title}${tool.description}`).not.toMatch(/https?:|\.com|[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it('fixed texts', () => {
    expect([PROFILE_REQUIRED, UNKNOWN_PROFILE, UNKNOWN_AGREEMENT]).toEqual(['profile is required', 'unknown profile', 'unknown agreement']);
  });

  it('input errors are ToolInputError with the fixed text and no client call', async () => {
    const { tool, a, b } = mk();
    for (const [args, text] of [[{}, PROFILE_REQUIRED], [{ profile: 'c' }, UNKNOWN_PROFILE], [{ profile: 'a', agreement: 'nope' }, UNKNOWN_AGREEMENT]] as const) {
      const e = await tool.run(args as never, ctx()).then(() => undefined, (x: unknown) => x);
      expect(e).toBeInstanceOf(ToolInputError);
      expect((e as Error).message).toBe(text);
    }
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('passes the id (not the label) to the client; no agreement means undefined', async () => {
    const { tool, a, b } = mk();
    await tool.run({ profile: 'a', agreement: 'x' }, ctx());
    expect(a).toHaveBeenLastCalledWith('id-a');
    await tool.run({ profile: 'a' }, ctx());
    expect(a).toHaveBeenLastCalledWith(undefined);
    await tool.run({ profile: 'b', agreement: 'x' }, ctx());
    expect(b).toHaveBeenLastCalledWith('id-b'); // first label wins
  });

  it('the result is the upstream array as is, with the profile id', async () => {
    const { tool } = mk();
    expect(await tool.run({ profile: 'b' }, ctx())).toEqual({ profile: 'b', channels: ['B'] });
  });

  it('a client rejection is not swallowed or rewrapped', async () => {
    const boom = new Error('boom');
    const tool = createListChannels({ clients: new Map([['a', { channels: async () => { throw boom; } }]]) as never, config: { profiles: { a: { agreements: [] } } } as never });
    await expect(tool.run({}, ctx())).rejects.toBe(boom);
  });
});

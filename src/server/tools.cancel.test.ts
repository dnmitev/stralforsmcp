// R-11: the MCP request's abort signal reaches the tool body through withSignal; a cancel is audited as `cancelled`.
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { currentSignal } from '../stralfors/abort.ts';
import { CancelledError } from '../stralfors/errors.ts';
import { callTool, registerAll } from './tools.ts';
import { mkDef, principal, sink } from '../../test/helpers/server.ts';
import { T } from '../../test/helpers/token-list.ts';

const pm = principal('pm', ['test']);
const deps = (s: ReturnType<typeof sink>) => ({ env: 'test' as const, allowWrite: false, prodValidateEnabled: false, audit: s.audit, now: () => T });
const untilAborted = mkDef('slow', 'read', async () => {
  const signal = currentSignal();
  await new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener('abort', () => resolve())));
  throw new CancelledError('request cancelled by the caller');
});

describe('cancel', () => {
  it('callTool runs the tool inside the given signal and audits a cancel as error/cancelled', async () => {
    const s = sink();
    const ac = new AbortController();
    const p = callTool(untilAborted, {}, pm, deps(s), undefined, ac.signal);
    ac.abort();
    expect((await p).isError).toBe(true);
    expect(s.lines()).toEqual([expect.objectContaining({ outcome: 'error', reason: 'cancelled', tool: 'slow' })]);
  });
  it('without a signal the tool sees none', async () => {
    let seen: AbortSignal | undefined = new AbortController().signal;
    await callTool(mkDef('peek', 'read', async () => ((seen = currentSignal()), { v: 1 })), {}, pm, deps(sink()));
    expect(seen).toBeUndefined();
  });
  it('an MCP client abort reaches the tool through the SDK request signal', async () => {
    const s = sink();
    const server = new McpServer({ name: 'x', version: '1' });
    registerAll(server, pm, [untilAborted], deps(s));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: 'c', version: '1' });
    await c.connect(b);
    const ac = new AbortController();
    const call = c.callTool({ name: 'slow', arguments: {} }, { signal: ac.signal }).catch((e: unknown) => e);
    setTimeout(() => ac.abort(), 50);
    await call;
    await expect.poll(() => s.lines()).toEqual([expect.objectContaining({ outcome: 'error', reason: 'cancelled', tool: 'slow' })]);
  });
});

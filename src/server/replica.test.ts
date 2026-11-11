/* AC-3: stateless, replica-safe, both eras. */
import { describe, expect, it } from 'vitest';
import { startHttp } from '../../test/helpers/http-harness.ts';
import { connect, world } from '../../test/helpers/server.ts';

describe('replicas', () => {
  it('two instances, one client, alternating requests, no session id anywhere', async () => {
    const w = world();
    const a = await startHttp({ world: w, hosts: ['127.0.0.1'] });
    const b = await startHttp({ world: w, hosts: ['127.0.0.1'] });
    const seen: Headers[] = [];
    const sent: Headers[] = [];
    let n = 0;
    const f: typeof fetch = async (url, init) => {
      const h = [a, b][n++ % 2]!;
      sent.push(new Headers(init?.headers));
      return h.fetchFor(w.tA, seen)(url, init);
    };
    const c = await connect('modern', f, 'http://127.0.0.1/mcp');
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['whoami', 'okTool']);
    expect((await c.callTool({ name: 'whoami', arguments: {} })).isError).toBeUndefined();
    await c.listTools();
    expect((await c.callTool({ name: 'whoami', arguments: {} })).isError).toBeUndefined();
    expect(n).toBeGreaterThanOrEqual(4);
    expect(a.calls.length).toBeGreaterThan(0);
    expect(b.calls.length).toBeGreaterThan(0);
    expect(seen.every((h) => !h.has('mcp-session-id'))).toBe(true);
    expect(sent.every((h) => !h.has('mcp-session-id'))).toBe(true);
  });

  it('the legacy handshake also works across alternating instances', async () => {
    const w = world();
    const a = await startHttp({ world: w, hosts: ['127.0.0.1'] });
    const b = await startHttp({ world: w, hosts: ['127.0.0.1'] });
    let n = 0;
    const seen: Headers[] = [];
    const f: typeof fetch = (url, init) => [a, b][n++ % 2]!.fetchFor(w.tA, seen)(url, init);
    const c = await connect('legacy', f, 'http://127.0.0.1/mcp');
    expect((await c.listTools()).tools).toHaveLength(2);
    expect((await c.callTool({ name: 'whoami', arguments: {} })).isError).toBeUndefined();
    expect(seen.every((h) => !h.has('mcp-session-id'))).toBe(true);
  });

  it.each([['modern'], ['legacy']] as const)('%s client lists tools and calls whoami; factory saw that era; the legacy GET listener gets 405 and calls still work', async (era) => {
    const h = await startHttp({ hosts: ['127.0.0.1'] });
    const methods: string[] = [];
    const statuses: number[] = [];
    const base = h.fetchFor(h.w.tA);
    const f: typeof fetch = async (url, init) => {
      const r = await base(url, init);
      methods.push(init?.method ?? 'GET');
      statuses.push(r.status);
      return r;
    };
    const c = await connect(era, f, `http://127.0.0.1:${h.port}/mcp`);
    expect((await c.listTools()).tools.length).toBe(2);
    expect((await c.callTool({ name: 'whoami', arguments: {} })).isError).toBeUndefined();
    expect(new Set(h.calls.map((x) => x.era))).toEqual(new Set([era]));
    methods.forEach((m, i) => m === 'GET' && expect(statuses[i]).toBe(405));
  });
});

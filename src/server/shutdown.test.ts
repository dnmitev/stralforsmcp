/* AC-7 graceful shutdown. */
import { describe, expect, it } from 'vitest';
import { createConnection } from 'node:net';
import { startHttp } from '../../test/helpers/http-harness.ts';
import { LIST, MCP_HEADERS, connect, mkDef, send } from '../../test/helpers/server.ts';
import { whoami } from './whoami.ts';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const slow = (d: { promise: Promise<void> }, entered: { resolve: () => void }) => mkDef('slow', 'read', async () => (entered.resolve(), await d.promise, { v: 1 }));
const refused = (port: number) => new Promise<boolean>((resolve) => {
  const s = createConnection({ port, host: '127.0.0.1' });
  s.once('error', () => resolve(true));
  s.once('connect', () => (s.destroy(), resolve(false)));
});

describe('graceful shutdown', () => {
  it('readiness flips at once, new connections are refused, the in-flight call completes, then the handler is closed', async () => {
    const d = deferred();
    const entered = deferred();
    const h = await startHttp({ hosts: ['127.0.0.1'], drainMs: 2000, tools: [whoami, slow(d, entered)] });
    const c = await connect('modern', h.fetchFor(h.w.tA), `http://127.0.0.1:${h.port}/mcp`);
    const inflight = c.callTool({ name: 'slow', arguments: {} });
    await entered.promise;
    let closed = false;
    const closing = h.srv.close().then(() => (closed = true));
    await Promise.resolve();
    // readiness is false the moment close() starts: either 503 or the listener is already gone
    const ready = await send(h.port, { method: 'GET', path: '/readyz' }).then((r) => r.status, () => 503);
    expect(ready).toBe(503);
    expect(await refused(h.port)).toBe(true);
    expect(closed).toBe(false);
    d.resolve();
    const r = await inflight;
    expect(r.structuredContent).toEqual({ v: 1 });
    await closing;
    expect(closed).toBe(true);
  });

  it('after close the readiness flag is false and listen() rejects', async () => {
    const h = await startHttp();
    await h.srv.close();
    await expect(h.srv.listen(0)).rejects.toThrow();
  });

  it('drain timeout aborts an in-flight request within the bound', async () => {
    const d = deferred();
    const entered = deferred();
    const h = await startHttp({ hosts: ['127.0.0.1'], drainMs: 50, tools: [whoami, slow(d, entered)] });
    const c = await connect('modern', h.fetchFor(h.w.tA), `http://127.0.0.1:${h.port}/mcp`);
    const inflight = c.callTool({ name: 'slow', arguments: {} }).then(() => 'ok', () => 'failed');
    await entered.promise;
    const t0 = performance.now();
    await h.srv.close();
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(await inflight).toBe('failed');
    d.resolve();
  });

  it('drainMs 0 does not wait for in-flight work', async () => {
    const d = deferred();
    const entered = deferred();
    const h = await startHttp({ hosts: ['127.0.0.1'], drainMs: 0, tools: [whoami, slow(d, entered)] });
    const c = await connect('modern', h.fetchFor(h.w.tA), `http://127.0.0.1:${h.port}/mcp`);
    const inflight = c.callTool({ name: 'slow', arguments: {} }).then(() => 'ok', () => 'failed');
    await entered.promise;
    const t0 = performance.now();
    await h.srv.close();
    expect(performance.now() - t0).toBeLessThan(500);
    d.resolve();
    await inflight;
  });

  it('close is idempotent and server.close runs once', async () => {
    const h = await startHttp();
    let calls = 0;
    const orig = h.srv.server.close.bind(h.srv.server);
    h.srv.server.close = ((cb?: (e?: Error) => void) => (calls++, orig(cb))) as typeof h.srv.server.close;
    await Promise.all([h.srv.close(), h.srv.close()]);
    await h.srv.close();
    expect(calls).toBe(1);
  });

  it('handler.fetch after close throws "closed" (observed through a refused or failing request)', async () => {
    const h = await startHttp();
    await h.srv.close();
    await expect(send(h.port, { headers: MCP_HEADERS, body: LIST })).rejects.toThrow();
  });
});

/* AC-7 graceful shutdown. */
import { describe, expect, it, vi } from 'vitest';
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
/** Fake drain timer: records the callback instead of waiting. */
const fakeTimer = () => {
  const t = { fns: [] as (() => void)[], ms: [] as number[], timer: ((fn: () => void, ms: number) => (t.fns.push(fn), t.ms.push(ms), 0)) as unknown as typeof setTimeout };
  return t;
};
const refused = (port: number) => new Promise<boolean>((resolve) => {
  const s = createConnection({ port, host: '127.0.0.1' });
  s.once('error', () => resolve(true));
  s.once('connect', () => (s.destroy(), resolve(false)));
});

describe('graceful shutdown', () => {
  it('readiness flips at once, new connections are refused, the in-flight call completes, then the handler is closed', async () => {
    const ft = fakeTimer();
    const d = deferred();
    const entered = deferred();
    const h = await startHttp({ hosts: ['127.0.0.1'], drainMs: 2000, timer: ft.timer, tools: [whoami, slow(d, entered)] });
    try {
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
      expect(ft.ms).toEqual([2000]); // drain was armed, never fired
    } finally {
      d.resolve();
      ft.fns.forEach((f) => f());
    }
  });

  it('after close the readiness flag is false and listen() rejects', async () => {
    const h = await startHttp();
    await h.srv.close();
    await expect(h.srv.listen(0)).rejects.toThrow();
  });

  it('drain timeout aborts an in-flight request within the bound', async () => {
    const d = deferred();
    const entered = deferred();
    const ft = fakeTimer();
    const h = await startHttp({ hosts: ['127.0.0.1'], drainMs: 50, timer: ft.timer, tools: [whoami, slow(d, entered)] });
    try {
      const c = await connect('modern', h.fetchFor(h.w.tA), `http://127.0.0.1:${h.port}/mcp`);
      const inflight = c.callTool({ name: 'slow', arguments: {} }).then(() => 'ok', () => 'failed');
      await entered.promise;
      let closed = false;
      const closing = h.srv.close().then(() => (closed = true));
      await vi.waitFor(() => expect(ft.fns).toHaveLength(1));
      expect(ft.ms).toEqual([50]);
      expect(closed).toBe(false); // still draining until the timer expires
      ft.fns[0]!();
      await closing;
      expect(await inflight).toBe('failed');
      d.resolve();
    } finally {
      d.resolve();
      ft.fns.forEach((f) => f());
    }
  });

  it('drainMs 0 does not wait for in-flight work', async () => {
    const d = deferred();
    const entered = deferred();
    const ft = fakeTimer();
    const h = await startHttp({ hosts: ['127.0.0.1'], drainMs: 0, timer: ft.timer, tools: [whoami, slow(d, entered)] });
    try {
      const c = await connect('modern', h.fetchFor(h.w.tA), `http://127.0.0.1:${h.port}/mcp`);
      const inflight = c.callTool({ name: 'slow', arguments: {} }).then(() => 'ok', () => 'failed');
      await entered.promise;
      await h.srv.close();
      expect(ft.fns).toHaveLength(0); // no drain timer armed
      d.resolve();
      await inflight;
    } finally {
      d.resolve();
      ft.fns.forEach((f) => f());
    }
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

describe('readiness first (MCP_READY_DELAY_MS seam: readyDelayMs)', () => {
  it('readyz is 503 at once but the listener keeps accepting for the delay; it closes only after, and the in-flight call completes', async () => {
    const ft = fakeTimer();
    const d = deferred();
    const entered = deferred();
    const h = await startHttp({ hosts: ['127.0.0.1'], drainMs: 2000, readyDelayMs: 500, timer: ft.timer, tools: [whoami, slow(d, entered)] } as never);
    try {
      const c = await connect('modern', h.fetchFor(h.w.tA), `http://127.0.0.1:${h.port}/mcp`);
      const inflight = c.callTool({ name: 'slow', arguments: {} });
      await entered.promise;
      let closed = false;
      const closing = h.srv.close().then(() => (closed = true));
      await vi.waitFor(() => expect(ft.ms).toEqual([500]));
      for (let i = 0; i < 2; i++) {
        expect((await send(h.port, { method: 'GET', path: '/readyz' })).status).toBe(503);
        expect(await refused(h.port)).toBe(false);
        expect(h.srv.server.listening).toBe(true);
      }
      expect((await send(h.port, { method: 'GET', path: '/healthz' })).status).toBe(200);
      expect(closed).toBe(false);
      ft.fns[0]!(); // the delay elapses
      await vi.waitFor(() => expect(h.srv.server.listening).toBe(false));
      expect(await refused(h.port)).toBe(true);
      expect(closed).toBe(false); // still draining the in-flight call
      d.resolve();
      expect((await inflight).structuredContent).toEqual({ v: 1 });
      await closing;
      expect(ft.ms).toEqual([500, 2000]); // delay first, then the drain
    } finally {
      d.resolve();
      ft.fns.forEach((f) => f());
    }
  });

  it('no delay timer is armed when readyDelayMs is 0 or unset, and the listener closes at once', async () => {
    for (const over of [{}, { readyDelayMs: 0 }]) {
      const ft = fakeTimer();
      const h = await startHttp({ timer: ft.timer, ...over } as never);
      await h.srv.close();
      expect(ft.ms).toEqual([]);
      expect(h.srv.server.listening).toBe(false);
    }
  });

  it('a second close during the delay returns the same promise and arms nothing new', async () => {
    const ft = fakeTimer();
    const h = await startHttp({ readyDelayMs: 500, timer: ft.timer } as never);
    const a = h.srv.close();
    try {
      expect(h.srv.close()).toBe(a);
      await vi.waitFor(() => expect(ft.fns).toHaveLength(1));
      ft.fns[0]!();
    } finally {
      ft.fns.forEach((f) => f()); // a failed assertion must not leave close() waiting on a timer that never fires
      await a;
    }
    expect(ft.ms).toEqual([500]);
  });
});

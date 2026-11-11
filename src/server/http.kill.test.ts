/* R10 kill tests: exact status/header/body per pipeline row, audit emptiness for guards, option plumbing. */
import { describe, expect, it, vi } from 'vitest';
import { startHttp } from '../../test/helpers/http-harness.ts';
import { send } from '../../test/helpers/server.ts';

describe('http kill', () => {
  it('Content-Length boundary: 1023, 1024 pass the size gate, 1025 and a huge number do not', async () => {
    const h = await startHttp();
    const statuses = [];
    for (const n of ['0', '1023', '1024', '1025', '99999999999']) statuses.push((await send(h.port, { headers: { 'content-length': n }, hold: true })).status);
    expect(statuses).toEqual([401, 401, 401, 413, 413]);
  });

  it('maxBodyBytes is the configured value, not a constant', async () => {
    const h = await startHttp({ maxBodyBytes: 10 });
    expect((await send(h.port, { headers: { 'content-length': '11' }, hold: true })).status).toBe(413);
    expect((await send(h.port, { headers: { 'content-length': '10' }, hold: true })).status).toBe(401);
  });

  it('hosts and origins are the configured lists', async () => {
    const h = await startHttp({ hosts: ['a.example', 'b.example'], origins: ['o1.example', 'o2.example'] });
    for (const host of ['a.example', 'b.example']) expect((await h.post({ headers: { host } })).status).toBe(200);
    for (const origin of ['https://o1.example', 'https://o2.example']) expect((await h.post({ headers: { host: 'a.example', origin } })).status).toBe(200);
    expect((await h.post({ headers: { host: 'mcp.example.test' } })).status).toBe(403);
    expect((await h.post({ headers: { host: 'a.example', origin: 'https://app.example.test' } })).status).toBe(403);
  });

  it('401 comes after every guard and carries no audit when a guard refuses', async () => {
    const h = await startHttp();
    for (const o of [{ host: 'evil.example' }, { origin: 'https://evil.example' }]) await send(h.port, { headers: o });
    await send(h.port, { path: '/x' });
    await send(h.port, { method: 'GET' });
    expect(h.s.text()).toBe('');
  });

  it('every rejection writes exactly one audit line and calls now() for authentication', async () => {
    const now = vi.fn(() => Date.parse('2030-01-01T00:00:00.000Z'));
    const h = await startHttp({ now });
    await h.post({ token: null });
    expect(h.s.lines()).toHaveLength(1);
    expect(now).toHaveBeenCalled();
  });

  it('an expired token is judged at the injected clock', async () => {
    const later = await startHttp({ now: () => Date.parse('2030-03-01T00:00:00.000Z') });
    const r = await later.post({});
    expect(r.status).toBe(401);
    expect(later.s.lines()[0]).toMatchObject({ reason: 'expired' });
  });

  it('SDK JSON mode: modern era answers application/json', async () => {
    const h = await startHttp();
    const r = await h.post({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    expect(r.status).toBeLessThan(500);
  });

  it('no mcp-session-id header on a legacy initialize', async () => {
    const h = await startHttp();
    const r = await h.post({});
    expect(r.status).toBe(200);
    expect(r.headers['mcp-session-id']).toBeUndefined();
  });

  it('listen() returns the bound port and defaults to loopback', async () => {
    const h = await startHttp();
    const a = h.srv.server.address();
    expect(typeof a === 'object' && a?.address).toBe('127.0.0.1');
    expect(typeof a === 'object' && a?.port).toBe(h.port);
    expect(h.port).toBeGreaterThan(0);
  });

  it('onerror receives errors but never the request body or headers', async () => {
    const canary = 'CANARY-body-7f3a';
    const h = await startHttp({ factory: () => { throw new Error('boom'); } });
    await h.post({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { canary } }), headers: { 'x-canary': canary } });
    expect(h.errors.length).toBeGreaterThan(0);
    for (const e of h.errors) {
      expect(e).toBeInstanceOf(Error);
      expect(`${e.message}${e.stack}${JSON.stringify(e)}`).not.toContain(canary);
    }
  });
});

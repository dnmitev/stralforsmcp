/*
 * R10 HTTP front, real node:http server on port 0, raw requests. API under test (src/server/http.ts): createHttpServer(o) => { listen, close, setReady, server }.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateToken, hashToken } from '../auth/index.ts';
import { UNAUTHORIZED_BODY, WWW_AUTHENTICATE, toAuthInfo } from './auth.ts';
import { startHttp } from '../../test/helpers/http-harness.ts';
import { LIST, MCP_HEADERS, connect, send } from '../../test/helpers/server.ts';
import { DAY, T } from '../../test/helpers/token-list.ts';

afterEach(() => vi.restoreAllMocks());

describe('health and readiness', () => {
  it('need no Host match and no token', async () => {
    const h = await startHttp();
    const a = await send(h.port, { method: 'GET', path: '/healthz', headers: { host: 'evil.example' } });
    expect([a.status, a.text, a.headers['content-type']]).toEqual([200, 'ok', expect.stringContaining('text/plain')]);
    const b = await send(h.port, { method: 'GET', path: '/readyz', headers: { host: 'evil.example' } });
    expect([b.status, b.text]).toEqual([200, 'ok']);
    h.srv.setReady(false);
    const c = await send(h.port, { method: 'GET', path: '/readyz', headers: { host: 'evil.example' } });
    expect([c.status, c.text, c.headers['content-type']]).toEqual([503, 'not ready', expect.stringContaining('text/plain')]);
    h.srv.setReady(true);
    expect((await send(h.port, { method: 'GET', path: '/readyz' })).status).toBe(200);
    expect(h.calls).toEqual([]);
    expect(h.s.text()).toBe('');
  });

  it('are served for any method and without a Host header', async () => {
    const h = await startHttp();
    expect((await send(h.port, { method: 'POST', path: '/healthz', headers: { host: null } })).status).toBe(200);
    expect((await send(h.port, { method: 'DELETE', path: '/readyz', headers: { host: null } })).status).toBe(200);
  });
});

describe('Host guard', () => {
  it.each([['mcp.example.test', true], ['mcp.example.test:8443', true], ['evil.example', false], [null, false]])('Host %s -> passes=%s', async (host, passes) => {
    const h = await startHttp();
    const r = await h.post({ headers: { host } });
    if (passes) expect(r.status).toBe(200);
    else {
      expect(r.status).toBe(403);
      expect(r.headers['content-type']).toContain('application/json');
      expect(JSON.parse(r.text)).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null });
      expect(h.calls).toEqual([]);
      expect(h.s.text()).toBe('');
    }
  });

  it('IPv6 literal with port passes against an allowlist of ::1', async () => {
    const h = await startHttp({ hosts: ['::1'] });
    expect((await h.post({ headers: { host: '[::1]:3000' } })).status).toBe(200);
  });

  it('upper-case Host is not a server error (behaviour recorded, not patched)', async () => {
    const h = await startHttp();
    expect([200, 403]).toContain((await h.post({ headers: { host: 'MCP.EXAMPLE.TEST' } })).status);
  });
});

describe('Origin guard', () => {
  it.each([[undefined, true], ['https://app.example.test', true], ['https://app.example.test:444', true], ['https://evil.example', false], ['null', false]])('Origin %s -> passes=%s', async (origin, passes) => {
    const h = await startHttp();
    const r = await h.post({ headers: { origin } });
    expect(r.status).toBe(passes ? 200 : 403);
    if (!passes) {
      expect(JSON.parse(r.text)).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null });
      expect(h.calls).toEqual([]);
      expect(h.s.text()).toBe('');
    }
  });
});

describe('path and method', () => {
  it('other path and trailing slash are 404', async () => {
    const h = await startHttp();
    for (const path of ['/other', '/mcp/', '/', '/MCP']) {
      const r = await h.post({ path });
      expect([r.status, r.text, r.headers['content-type']]).toEqual([404, 'not found', expect.stringContaining('text/plain')]);
    }
  });

  it('query string is ignored for the path check', async () => {
    const h = await startHttp();
    expect((await h.post({ path: '/mcp?x=1' })).status).toBe(200);
  });

  it.each(['GET', 'DELETE', 'PUT', 'OPTIONS'])('%s /mcp is 405 with Allow: POST, no audit, no factory call', async (method) => {
    const h = await startHttp();
    const r = await send(h.port, { method, headers: { authorization: `Bearer ${h.w.tA}` } });
    expect([r.status, r.text, r.headers.allow]).toEqual([405, 'method not allowed', 'POST']);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(h.calls).toEqual([]);
    expect(h.s.text()).toBe('');
  });
});

describe('body size', () => {
  it('a declared Content-Length above the limit is 413 before authentication', async () => {
    const h = await startHttp();
    const r = await send(h.port, { headers: { 'content-length': '1025', 'content-type': 'application/json' }, hold: true });
    expect([r.status, r.text]).toEqual([413, 'payload too large']);
    expect(r.headers.connection).toBe('close');
    expect(r.headers['content-type']).toContain('text/plain');
    expect(h.s.text()).toBe('');
  });

  it('the limit is inclusive: 1024 declared reaches authentication', async () => {
    const h = await startHttp();
    const r = await send(h.port, { headers: { 'content-length': '1024', 'content-type': 'application/json' }, hold: true });
    expect(r.status).toBe(401);
  });

  it('a chunked body above the limit is refused by the SDK and never reaches the factory', async () => {
    const h = await startHttp();
    const r = await h.post({ body: 'x'.repeat(2048), headers: { 'transfer-encoding': 'chunked' } });
    expect(r.status).toBe(413);
    expect(h.calls).toEqual([]);
  });
});

describe('guard order', () => {
  it('Host before Origin before path before method', async () => {
    const h = await startHttp();
    const hdr = { origin: 'https://evil.example' };
    expect((await send(h.port, { method: 'GET', path: '/other', headers: { ...hdr, host: 'evil.example' } })).status).toBe(403);
    expect((await send(h.port, { method: 'GET', path: '/other', headers: hdr })).status).toBe(403);
    expect((await send(h.port, { method: 'GET', path: '/other' })).status).toBe(404);
    expect((await send(h.port, { method: 'GET', path: '/mcp' })).status).toBe(405);
  });

  it('method before declared size before authentication', async () => {
    const h = await startHttp();
    expect((await send(h.port, { method: 'PUT', headers: { 'content-length': '5000' }, hold: true })).status).toBe(405);
    expect((await send(h.port, { headers: { 'content-length': '5000' }, hold: true })).status).toBe(413);
    expect(h.s.text()).toBe('');
  });
});

describe('authentication before the handler', () => {
  const causes = (h: Awaited<ReturnType<typeof startHttp>>): [string, string | null, string, Record<string, string | undefined>?][] => [
    ['absent', null, 'malformed'],
    ['Basic', null, 'malformed', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['not a token', 'not-a-token', 'malformed'],
    ['unknown', generateToken(), 'unknown'],
    ['revoked', h.w.tRevoked, 'revoked'],
    ['expired', h.w.tExpired, 'expired'],
    ['future', h.w.tFuture, 'expired'],
  ];

  it('seven requests, six causes: identical 401, one anonymous audit line each, factory untouched', async () => {
    const h = await startHttp();
    const tuples = new Set<string>();
    const expected: string[] = [];
    for (const [, token, code, hdr] of causes(h)) {
      const r = await h.post({ token, headers: hdr, body: LIST });
      expect(r.status).toBe(401);
      expect(r.headers['www-authenticate']).toBe(WWW_AUTHENTICATE);
      expect(r.headers['content-type']).toContain('application/json');
      expect(r.text).toBe(UNAUTHORIZED_BODY);
      tuples.add(JSON.stringify([r.status, r.headers['www-authenticate'], r.headers['content-type'], r.text]));
      expected.push(code);
    }
    expect(tuples.size).toBe(1);
    expect(h.calls).toEqual([]);
    const lines = h.s.lines();
    expect(lines.map((l) => l.reason)).toEqual(expected);
    for (const l of lines) {
      expect(l).toMatchObject({ userId: 'anonymous', role: 'anonymous', tool: 'auth', env: 'test', outcome: 'denied', durationMs: 0 });
      expect('traceId' in l).toBe(false);
    }
  });

  it('the 401 does not depend on hosts or env and has no error_description', async () => {
    const a = await startHttp({ hosts: ['a.example'] , env: 'prod' });
    const r = await send(a.port, { headers: { ...MCP_HEADERS, host: 'a.example' }, body: LIST });
    expect(r.text).toBe(UNAUTHORIZED_BODY);
    expect(r.text).not.toContain('error_description');
    expect(r.headers['www-authenticate']).not.toContain('error_description');
    expect(a.s.lines()[0]).toMatchObject({ env: 'prod', reason: 'malformed' });
  });

  it('a valid token reaches the factory with the principal and an empty token', async () => {
    const h = await startHttp({ hosts: ['127.0.0.1'] });
    const c = await connect('modern', h.fetchFor(h.w.tA), `http://127.0.0.1:${h.port}/mcp`);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['whoami', 'okTool']);
    expect(h.calls.length).toBeGreaterThanOrEqual(1);
    const expected = toAuthInfo({ userId: 'u1', name: 'User One', role: 'dev', envs: ['test', 'prod'] }, T + 30 * DAY);
    for (const ctx of h.calls) {
      expect(ctx.authInfo).toEqual(expected);
      expect(ctx.authInfo?.token).toBe('');
      const json = JSON.stringify(ctx.authInfo);
      expect(json).not.toContain(h.w.tA);
      expect(json).not.toContain(hashToken(h.w.tA));
    }
    expect(h.s.lines().filter((l) => l.tool === 'auth')).toEqual([]);
  });

  it('a user whose envs exclude the deployment env authenticates but sees nothing', async () => {
    const h = await startHttp({ hosts: ['127.0.0.1'], env: 'prod' });
    const c = await connect('modern', h.fetchFor(h.w.tPm), `http://127.0.0.1:${h.port}/mcp`);
    expect((await c.listTools()).tools).toEqual([]);
    await expect(c.callTool({ name: 'whoami', arguments: {} })).rejects.toThrow(/not found/);
    expect(h.s.lines()).toEqual([]);
  });
});

describe('canary sweep', () => {
  it('no token or digest in any response, audit line, onerror argument, stdout or stderr', async () => {
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const h = await startHttp({ hosts: ['127.0.0.1', 'mcp.example.test'] });
    const canaries = [h.w.tA, hashToken(h.w.tA), h.w.tRevoked, hashToken(h.w.tRevoked), h.w.unknown, hashToken(h.w.unknown)];
    const seen: string[] = [];
    const keep = (r: { status: number; headers: unknown; text: string }) => seen.push(JSON.stringify([r.headers, r.text]));
    for (const t of [h.w.tA, h.w.tRevoked, h.w.unknown, h.w.tExpired]) keep(await h.post({ token: t }));
    keep(await h.post({ token: h.w.tA, headers: { host: 'evil.example' } }));
    keep(await h.post({ token: h.w.tA, headers: { origin: 'https://evil.example' } }));
    keep(await h.post({ token: h.w.tA, path: '/nope' }));
    keep(await h.post({ token: h.w.tA, body: 'x'.repeat(2048), headers: { 'transfer-encoding': 'chunked' } }));
    keep(await h.post({ token: h.w.tA, body: '{not json' }));
    const c = await connect('modern', h.fetchFor(h.w.tA), `http://127.0.0.1:${h.port}/mcp`);
    seen.push(JSON.stringify(await c.callTool({ name: 'whoami', arguments: {} })));
    const everything = [...seen, h.s.text(), ...h.errors.map((e) => `${e.message}\n${e.stack}`), ...out.mock.calls.map((a) => String(a[0])), ...err.mock.calls.map((a) => String(a[0]))].join('\n');
    // the audit sink writes to its own array, so process.stdout is expected to be quiet of canaries
    for (const canary of canaries) expect(everything).not.toContain(canary);
  });
});

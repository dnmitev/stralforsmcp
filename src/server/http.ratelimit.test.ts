/*
 * R22 per-principal rate limit in the HTTP front. API under test: HttpServerOptions.limiter (src/server/http.ts), TOO_MANY_BODY.
 * The harness passes the limiter explicitly here; once the option is required (A31) the harness default must be added by the Developer.
 */
import { describe, expect, it } from 'vitest';
import { MCP_HEADERS, send } from '../../test/helpers/server.ts';
import { startHttp } from '../../test/helpers/http-harness.ts';
import { generateToken } from '../auth/index.ts';
import { createRateLimiter } from './rate-limit.ts';
import { TOO_MANY_BODY } from './http.ts';

const T0 = 1_000_000;
const setup = async () => {
  const clock = { t: T0 };
  const limiter = createRateLimiter({ perMinute: 60, burst: 2, now: () => clock.t });
  const h = await startHttp({ limiter });
  return { h, clock, limiter };
};
const rateLines = (h: Awaited<ReturnType<typeof startHttp>>) => h.s.lines().filter((l) => l.reason === 'rate_limited');

describe('rate limit in front of the handler', () => {
  it('the N+1th request is refused with 429, Retry-After and a fixed body; the handler is untouched; one audit line', async () => {
    const { h } = await setup();
    expect(TOO_MANY_BODY).toBe('too many requests');
    expect((await h.post()).status).toBe(200);
    expect((await h.post()).status).toBe(200);
    expect(h.calls).toHaveLength(2);
    const r = await h.post();
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('1');
    expect(r.headers['content-type']).toBe('text/plain');
    expect(r.text).toBe('too many requests');
    expect(h.calls).toHaveLength(2);
    expect(rateLines(h)).toHaveLength(1);
    expect(rateLines(h)[0]).toMatchObject({ userId: 'u1', role: 'dev', tool: '-', env: 'test', outcome: 'denied', reason: 'rate_limited', durationMs: 0 });
    expect('traceId' in rateLines(h)[0]!).toBe(false);
    expect(`${r.text}${JSON.stringify(r.headers)}`).not.toMatch(new RegExp(`${h.w.tA}|u1`));
  });

  it('other principals are unaffected', async () => {
    const { h } = await setup();
    for (let i = 0; i < 3; i++) await h.post();
    expect((await h.post({ token: h.w.tPm })).status).toBe(200);
  });

  it('unauthenticated requests never create buckets', async () => {
    const { h, limiter } = await setup();
    for (let i = 0; i < 50; i++) await h.post({ token: generateToken() });
    for (let i = 0; i < 50; i++) await h.post({ token: null });
    for (let i = 0; i < 50; i++) await h.post({ headers: { host: 'evil.example' } });
    for (let i = 0; i < 50; i++) await h.post({ path: '/healthz' });
    expect(limiter.size()).toBe(0);
    expect(h.s.lines()).toHaveLength(100);
    expect(new Set(h.s.lines().map((l) => l.reason))).toEqual(new Set(['unknown', 'malformed']));
  });

  it('order: auth before limit, guards before limit', async () => {
    const { h, limiter } = await setup();
    for (let i = 0; i < 3; i++) await h.post();
    const size = limiter.size();
    const before = rateLines(h).length;
    expect((await h.post({ token: h.w.tRevoked })).status).toBe(401);
    expect(limiter.size()).toBe(size);
    expect((await send(h.port, { headers: { ...MCP_HEADERS, authorization: `Bearer ${h.w.tA}`, 'content-length': '2048' }, hold: true })).status).toBe(413);
    expect(rateLines(h)).toHaveLength(before);
  });

  it('health endpoints are never limited', async () => {
    const { h, limiter } = await setup();
    for (const path of ['/healthz', '/readyz']) for (let i = 0; i < 100; i++) expect((await h.post({ path })).status).toBe(200);
    expect(limiter.size()).toBe(0);
  });

  it('recovers when time advances; each rejection is its own audit line', async () => {
    const { h, clock } = await setup();
    for (let i = 0; i < 3; i++) await h.post();
    for (let i = 0; i < 5; i++) expect((await h.post()).status).toBe(429);
    expect(rateLines(h)).toHaveLength(6);
    clock.t += 1000;
    expect((await h.post()).status).toBe(200);
  });
});

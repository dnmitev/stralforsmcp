// R-12: kills for the mutants of src/server/http.ts that earlier tests left alive (error path without telemetry, close/listen race, duration subtraction, bad-URL measure).
import { describe, expect, it, vi } from 'vitest';
import { startHttp } from '../../test/helpers/http-harness.ts';
import { INIT, send } from '../../test/helpers/server.ts';
import { canaries, hist, memTelemetry } from '../../test/helpers/telemetry.ts';

const DUR = 'http.server.request.duration';
const bound = (m: ReturnType<typeof memTelemetry>, n: number) => vi.waitFor(async () => expect((await m.series(DUR)).reduce((k, s) => k + hist(s).count, 0)).toBe(n));

describe('failure outside the SDK handler, without telemetry', () => {
  // the SDK turns factory errors into its own response; what reaches fail() is a throw in our own code, here the audit sink on a 401
  it('answers 500 with a fixed body and reports one fixed-text error without the cause', async () => {
    const c = canaries();
    const h = await startHttp({ audit: { record: () => { throw new Error(c.msg); } } });
    const r = await h.post({ token: h.w.unknown });
    expect([r.status, r.text]).toEqual([500, 'internal error']);
    expect(h.errors.map((e) => e.message)).toEqual(['request failed: Error']);
    expect(JSON.stringify([r, h.errors.map((e) => e.message)])).not.toContain(c.msg);
  });

  it('a thrown non-Error is reported as `unknown`', async () => {
    const h = await startHttp({ audit: { record: () => { throw 'plain string'; } } }); // eslint-disable-line no-throw-literal
    expect((await h.post({ token: h.w.unknown })).status).toBe(500);
    expect(h.errors.map((e) => e.message)).toEqual(['request failed: unknown']);
  });
});

describe('listen after close', () => {
  it('rejects with the fixed text instead of listening again', async () => {
    const h = await startHttp();
    await h.srv.close();
    await expect(h.srv.listen(0)).rejects.toThrow('server is closed');
  });
});

describe('duration histogram', () => {
  it('is end minus start, not a sum: a clock that does not start at zero', async () => {
    const m = memTelemetry();
    let ms = 999_750; // start 1_000_000, finish 1_000_250 -> 0.25 s
    const h = await startHttp({ telemetry: m.t, monotonic: () => (ms += 250) });
    await h.post({ body: INIT });
    await bound(m, 1);
    expect(hist((await m.series(DUR))[0]).sum).toBe(0.25);
  });

  it('an unparsable request target is still measured (status 400)', async () => {
    const m = memTelemetry();
    const h = await startHttp({ telemetry: m.t });
    expect((await send(h.port, { method: 'GET', path: 'http://[', headers: { host: 'mcp.example.test' } })).status).toBe(400);
    await bound(m, 1);
    expect((await m.series(DUR))[0]!.attributes['http.response.status_code']).toBe(400);
  });
});

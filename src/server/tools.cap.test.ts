import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_OUTPUT_BYTES, TOO_LARGE_TEXT, callTool } from './tools.ts';
import { mkDef, principal, sink } from '../../test/helpers/server.ts';
import { T } from '../../test/helpers/token-list.ts';

const pm = principal('pm', ['test']);
const big = (n: number) => mkDef('big', 'read', async () => ({ v: 'x'.repeat(n) }) as never);
const deps = (maxOutputBytes?: number) => {
  const s = sink();
  return { s, deps: { env: 'test' as const, allowWrite: false, prodValidateEnabled: false, audit: s.audit, now: () => T, maxOutputBytes } };
};
const overhead = JSON.stringify({ v: '' }).length; // {"v":""}

describe('output cap', () => {
  it('fixed text and default', () => {
    expect(TOO_LARGE_TEXT).toBe('tool output too large; narrow the request');
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(262_144);
  });
  it('refuses above the cap with a too_large audit line and no output', async () => {
    const { s, deps: d } = deps(100);
    const r = await callTool(big(100), {}, pm, d);
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: TOO_LARGE_TEXT }] });
    expect(s.lines()).toHaveLength(1);
    expect(s.lines()[0]).toMatchObject({ outcome: 'error', reason: 'too_large' });
    expect(s.text()).not.toContain('xxxx');
  });
  it('returns a result of exactly the cap unchanged', async () => {
    const { s, deps: d } = deps(100);
    const r = await callTool(big(100 - overhead), {}, pm, d);
    expect('isError' in r).toBe(false);
    expect(r.structuredContent).toEqual({ v: 'x'.repeat(100 - overhead) });
    expect(s.lines()[0]).toMatchObject({ outcome: 'allowed' });
  });
  it('one byte over is refused', async () => {
    const r = await callTool(big(101 - overhead), {}, pm, deps(100).deps);
    expect(r.isError).toBe(true);
  });
  it('counts bytes, not characters', async () => {
    const r = await callTool(mkDef('mb', 'read', async () => ({ v: 'é'.repeat(30) }) as never), {}, pm, deps(50).deps);
    expect(r.isError).toBe(true);
  });
  it('uses the default when none is given', async () => {
    expect((await callTool(big(DEFAULT_MAX_OUTPUT_BYTES), {}, pm, deps().deps)).isError).toBe(true);
    expect((await callTool(big(DEFAULT_MAX_OUTPUT_BYTES - overhead), {}, pm, deps().deps)).isError).toBeUndefined();
  });
});

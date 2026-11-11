/* R12 kill tests: duration arithmetic, ordering of checks, one audit line, no mutation of inputs. */
import { describe, expect, it } from 'vitest';
import { callTool } from './tools.ts';
import { mkDef, okTool, principal, sink } from '../../test/helpers/server.ts';

const run = async (ticks: number[], def = okTool, over: object = {}) => {
  const s = sink();
  const q = [...ticks];
  const r = await callTool(def, {}, principal('pm', ['test']), { env: 'test', allowWrite: false, audit: s.audit, now: () => q.shift() ?? 0, ...over });
  return { s, r };
};

describe('callTool kill', () => {
  it('rounds fractional durations', async () => {
    expect((await run([1000, 1000.4])).s.lines()[0]!.durationMs).toBe(0);
    expect((await run([1000, 1000.6])).s.lines()[0]!.durationMs).toBe(1);
  });
  it('a clock that goes backwards clamps to 0', async () => {
    expect((await run([1000, 900])).s.lines()[0]!.durationMs).toBe(0);
  });
  it('start is read before the policy check and the end after run', async () => {
    expect((await run([10, 60])).s.lines()[0]!.durationMs).toBe(50);
    const denied = await run([10, 25], mkDef('w', 'write'));
    expect(denied.s.lines()[0]!.durationMs).toBe(15);
  });
  it('an error path also measures its duration', async () => {
    const def = mkDef('boom', 'read', async () => { throw new Error('x'); });
    expect((await run([5, 105], def)).s.lines()[0]!.durationMs).toBe(100);
  });
  it('run is never invoked when denied (policy before run)', async () => {
    let calls = 0;
    const def = mkDef('w', 'write', async () => (calls++, { v: 1 }));
    await run([0, 0], def);
    expect(calls).toBe(0);
  });
  it('successful result has no reason key on the audit and carries structuredContent identical to the text', async () => {
    const { r, s } = await run([0, 0], mkDef('o', 'read', async () => ({ v: 7 })));
    expect(r.structuredContent).toEqual({ v: 7 });
    expect((r.content[0] as { text: string }).text).toBe('{"v":7}');
    expect('reason' in s.lines()[0]!).toBe(false);
  });
  it('error line has no free text beyond the fixed reason', async () => {
    const def = mkDef('boom', 'read', async () => { throw new Error('SECRET-CANARY'); });
    expect((await run([0, 0], def)).s.text()).not.toContain('SECRET-CANARY');
  });
});

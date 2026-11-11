/*
 * R32 logger: createLogger({ mixin? }) and the allowlist grown by exactly 'trace_id' and 'span_id' (14 keys).
 * No OTel import here: the mixin is a plain function.
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from './log.ts';

const mk = (mixin?: () => Record<string, string>) => {
  const chunks: string[] = [];
  const log = createLogger({ level: 'trace', destination: { write: (s) => void chunks.push(s) }, ...(mixin ? { mixin } : {}) });
  return { log, lines: () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
};

describe('allowlist has exactly 14 keys', () => {
  it('accepts trace_id and span_id, drops and counts everything else', () => {
    const { log, lines } = mk();
    log.info({ trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), traceparent: 'X-CANARY', userId: 'U-CANARY' }, 'm');
    const l = lines()[0]!;
    expect([l.trace_id, l.span_id]).toEqual(['a'.repeat(32), 'b'.repeat(16)]);
    expect('traceparent' in l || 'userId' in l).toBe(false);
    expect(log.droppedKeys).toBe(2);
    expect(JSON.stringify(l)).not.toContain('CANARY');
  });

  it('the vendor traceId is still accepted and distinct', () => {
    const { log, lines } = mk();
    log.warn({ traceId: 'vendor-text', trace_id: 'a'.repeat(32) });
    expect(lines()[0]).toMatchObject({ traceId: 'vendor-text', trace_id: 'a'.repeat(32) });
    expect(log.droppedKeys).toBe(0);
  });

  it('non-primitive values under the new keys are still dropped', () => {
    const { log, lines } = mk();
    log.info({ trace_id: { x: 1 }, span_id: ['y'] });
    expect('trace_id' in lines()[0]! || 'span_id' in lines()[0]!).toBe(false);
    expect(log.droppedKeys).toBe(2);
  });
});

describe('mixin option', () => {
  it('its output is merged into every line at every level, without touching droppedKeys', () => {
    const { log, lines } = mk(() => ({ trace_id: 'c'.repeat(32), span_id: 'd'.repeat(16) }));
    for (const l of ['trace', 'debug', 'info', 'warn', 'error'] as const) log[l]({ status: 200 }, l);
    expect(lines()).toHaveLength(5);
    for (const l of lines()) expect(l).toMatchObject({ trace_id: 'c'.repeat(32), span_id: 'd'.repeat(16), status: 200 });
    expect(log.droppedKeys).toBe(0);
  });

  it('is called per line (an empty result adds nothing)', () => {
    let on = true;
    const { log, lines } = mk((): Record<string, string> => (on ? { trace_id: 'e'.repeat(32) } : {}));
    log.info({}, 'in');
    on = false;
    log.info({}, 'out');
    expect(lines()[0]!.trace_id).toBe('e'.repeat(32));
    expect('trace_id' in lines()[1]!).toBe(false);
  });

  it('no mixin: lines are as before', () => {
    const { log, lines } = mk();
    log.info({ status: 1 }, 'm');
    expect(Object.keys(lines()[0]!).sort()).toEqual(['level', 'msg', 'name', 'pid', 'hostname', 'status', 'time'].sort());
  });

  it('documents the boundary (A52): pino merges the mixin AFTER the allowlist, so a hostile mixin is not filtered', () => {
    const { log, lines } = mk(() => ({ secret: 'S-CANARY' }));
    log.info({}, 'm');
    expect(lines()[0]!.secret).toBe('S-CANARY'); // the only mixin ever passed is logMixin (two fixed-format keys)
  });
});

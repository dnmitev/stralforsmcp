import { describe, expect, it } from 'vitest';
import { currentSignal, detached, untilAborted, withSignal } from './abort.ts';
import { CancelledError } from './errors.ts';

describe('abort scope', () => {
  it('withSignal sets the scope, nests, and an undefined signal leaves the outer one', () => {
    const a = new AbortController().signal;
    const b = new AbortController().signal;
    expect(currentSignal()).toBeUndefined();
    withSignal(a, () => {
      expect(currentSignal()).toBe(a);
      withSignal(b, () => expect(currentSignal()).toBe(b));
      withSignal(undefined, () => expect(currentSignal()).toBe(a));
      detached(() => expect(currentSignal()).toBeUndefined());
    });
  });
  it('untilAborted passes values and errors through, rejects on abort without touching the promise', async () => {
    await expect(untilAborted(Promise.resolve(1))).resolves.toBe(1);
    const ac = new AbortController();
    await expect(untilAborted(Promise.resolve(2), ac.signal)).resolves.toBe(2);
    await expect(untilAborted(Promise.reject(new Error('x')), ac.signal)).rejects.toThrow('x');
    let done = false;
    const p = new Promise<number>((r) => setTimeout(() => ((done = true), r(3)), 30));
    const w = untilAborted(p, ac.signal);
    ac.abort();
    const e = await w.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CancelledError);
    expect((e as CancelledError).message).toBe('request cancelled by the caller');
    expect(await p).toBe(3);
    expect(done).toBe(true);
    const pre = new AbortController();
    pre.abort();
    await expect(untilAborted(new Promise(() => undefined), pre.signal)).rejects.toBeInstanceOf(CancelledError);
  });
  it('reads the current scope by default', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(withSignal(ac.signal, () => untilAborted(new Promise(() => undefined)))).rejects.toBeInstanceOf(CancelledError);
  });
  it('removes its abort listener once the promise settles', async () => {
    const ac = new AbortController();
    let added = 0, removed = 0;
    const add = ac.signal.addEventListener.bind(ac.signal), rem = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...a: Parameters<typeof add>) => (added++, add(...a))) as typeof add;
    ac.signal.removeEventListener = ((...a: Parameters<typeof rem>) => (removed++, rem(...a))) as typeof rem;
    await untilAborted(Promise.resolve(1), ac.signal);
    await untilAborted(Promise.reject(new Error('y')), ac.signal).catch(() => undefined);
    expect([added, removed]).toEqual([2, 2]);
  });
});

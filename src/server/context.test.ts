/* R18 principal context. API under test (src/server/context.ts): withPrincipal(p, fn), currentPrincipal(). */
import { describe, expect, it } from 'vitest';
import { currentPrincipal, withPrincipal } from './context.ts';
import { principal } from '../../test/helpers/server.ts';

const p1 = principal('dev', ['test'], 'One');
const p2 = principal('qa', ['test'], 'Two');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('principal context', () => {
  it('visible inside, absent before and after; same reference', () => {
    expect(currentPrincipal()).toBeUndefined();
    expect(withPrincipal(p1, () => currentPrincipal())).toBe(p1);
    expect(currentPrincipal()).toBeUndefined();
  });

  it('survives await and timers', async () => {
    const v = await withPrincipal(p1, async () => {
      await Promise.resolve();
      await sleep(1);
      return currentPrincipal();
    });
    expect(v).toBe(p1);
  });

  it('concurrent contexts do not bleed', async () => {
    const run = (p: typeof p1) => withPrincipal(p, async () => (await sleep(5), currentPrincipal()));
    const [a, b] = await Promise.all([run(p1), run(p2)]);
    expect(a).toBe(p1);
    expect(b).toBe(p2);
  });

  it('nested contexts restore the outer one', () => {
    expect(withPrincipal(p1, () => withPrincipal(p2, currentPrincipal))).toBe(p2);
    expect(withPrincipal(p1, () => (withPrincipal(p2, () => 0), currentPrincipal()))).toBe(p1);
  });

  it('return value and throw pass through', () => {
    expect(withPrincipal(p1, () => 42)).toBe(42);
    const e = new Error('x');
    expect(() => withPrincipal(p1, () => { throw e; })).toThrow(e);
    expect(currentPrincipal()).toBeUndefined();
  });

  it('exports exactly withPrincipal and currentPrincipal', async () => {
    expect(Object.keys(await import('./context.ts')).sort()).toEqual(['currentPrincipal', 'withPrincipal']);
  });
});

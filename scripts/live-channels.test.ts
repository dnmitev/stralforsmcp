import { describe, expect, it } from 'vitest';
import { Claims, AgreementNotFoundError } from '../src/stralfors/index.ts';
import { report } from './live-channels.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const fake = (fail: string[] = []) => ({
  token: { get: async () => ({ claims: new Claims({ scope: 'a b', exp: 1, aud: 'x', customer: 'c/SE' }) }) },
  channels: async (id?: string) => {
    if (id && fail.includes(id)) throw new AgreementNotFoundError('nope');
    return id ? [`ch-${id.slice(0, 1)}`] : ['all'];
  },
});

describe('live-channels report', () => {
  it('uses labels, falls back to #n, and never prints ids', async () => {
    const out = await report(fake(), [{ label: 'test-a', id: A }, { id: B }, { id: C }]);
    expect(out).toContain('test-a: ch-1');
    expect(out).toContain('#2: ch-2');
    expect(out).toContain('#3: ch-3');
    expect(out).toContain('scopes: a b');
    expect(out).toContain('customerCountry: SE');
    for (const id of [A, B, C]) expect(out).not.toContain(id);
  });

  it('reports a failing agreement by kind and continues', async () => {
    const out = await report(fake([A]), [{ label: 'test-a', id: A }, { label: 'test-b', id: B }]);
    expect(out).toContain('test-a: ');
    expect(out).not.toContain('test-a: ch-');
    expect(out).toContain('test-b: ch-2');
    expect(out).not.toContain(A);
  });
});

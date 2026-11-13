import { describe, expect, it } from 'vitest';
import { buildMcp } from './mcp.ts';
import { mkDef, principal, sink, toAuth } from '../../test/helpers/server.ts';

const P95_BOUND_MS = 5;
const tools = Array.from({ length: 12 }, (_, i) => mkDef(`tool${i}`, 'read'));

describe('per-request factory', () => {
  it('stays cheap with 12 tools (p95 bound)', () => {
    const factory = buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, audit: sink().audit, tools });
    const auth = toAuth(principal('dev', ['test']));
    const ctx = { authInfo: auth } as Parameters<typeof factory>[0];
    for (let i = 0; i < 20; i++) void factory(ctx); // warm up
    const ms: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      void factory(ctx);
      ms.push(performance.now() - t);
    }
    ms.sort((a, b) => a - b);
    expect(ms[Math.floor(ms.length * 0.95)]!).toBeLessThan(P95_BOUND_MS);
  });
});

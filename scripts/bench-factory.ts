// Run by hand or in a scheduled job, never in the unit suite (timing is not deterministic): npm run bench:factory
import { buildMcp } from '../src/server/mcp.ts';
import { mkDef, principal, sink, toAuth } from '../test/helpers/server.ts';

const BOUND_MS = 5;
const factory = buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, audit: sink().audit, tools: Array.from({ length: 12 }, (_, i) => mkDef(`tool${i}`, 'read')) });
const ctx = { authInfo: toAuth(principal('dev', ['test'])) } as Parameters<typeof factory>[0];
for (let i = 0; i < 20; i++) void factory(ctx);
const ms: number[] = [];
for (let i = 0; i < 200; i++) {
  const t = performance.now();
  void factory(ctx);
  ms.push(performance.now() - t);
}
ms.sort((a, b) => a - b);
const p95 = ms[Math.floor(ms.length * 0.95)]!;
process.stdout.write(`factory p95 ${p95.toFixed(3)} ms (bound ${BOUND_MS} ms)\n`);
process.exit(p95 < BOUND_MS ? 0 : 1);

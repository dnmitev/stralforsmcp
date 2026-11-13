// Deterministic guard: the per-request factory is synchronous and registers every visible tool, no I/O.
// The timing bound (p95 < 5 ms with 12 tools) lives in scripts/bench-factory.ts, outside the test suite.
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { buildMcp } from './mcp.ts';
import { mkDef, principal, sink, toAuth } from '../../test/helpers/server.ts';

const tools = Array.from({ length: 12 }, (_, i) => mkDef(`tool${i}`, 'read'));

describe('per-request factory', () => {
  it('builds synchronously and registers all 12 tools for a principal that sees them', () => {
    const spy = vi.spyOn(McpServer.prototype, 'registerTool');
    try {
      const factory = buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, audit: sink().audit, tools });
      const server = factory({ authInfo: toAuth(principal('dev', ['test'])) } as Parameters<typeof factory>[0]);
      expect(server).toBeInstanceOf(McpServer); // not a promise: nothing awaited
      expect(spy.mock.calls.map((c) => c[0])).toEqual(tools.map((t) => t.spec.name));
    } finally {
      spy.mockRestore();
    }
  });
  it('registers nothing without a principal', () => {
    const spy = vi.spyOn(McpServer.prototype, 'registerTool');
    try {
      const factory = buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, audit: sink().audit, tools });
      factory({} as Parameters<typeof factory>[0]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

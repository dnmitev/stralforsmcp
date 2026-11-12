// L7: a failing http.start() prints one fixed line and exits 1. StreamableHTTPClientTransport.start() does no I/O (it throws only when started twice),
// so the failure cannot be provoked black-box; the transports are stubbed and the bridge module is run in-process.
import { afterEach, describe, expect, it, vi } from 'vitest';

const LEAK = 'https://secret-host.example.invalid/mcp?k=CANARY';
vi.mock('@modelcontextprotocol/client', () => ({
  StreamableHTTPClientTransport: class {
    async start() { throw new Error(`fetch failed for ${LEAK}`); }
    async close() {}
    async send() {}
  },
}));
vi.mock('@modelcontextprotocol/server/stdio', () => ({
  StdioServerTransport: class {
    async start() {}
    async close() {}
    async send() {}
  },
}));

afterEach(() => vi.restoreAllMocks());

describe('bridge start failure', () => {
  it('prints the fixed line, exits 1, leaks nothing', async () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => (err.push(String(s)), true)) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`exit:${c}`); }) as never);
    vi.stubEnv('MCP_URL', 'http://127.0.0.1:9/mcp');
    vi.stubEnv('MCP_TOKEN', 'x'.repeat(8));
    await import('../extension/src/proxy.ts').catch(() => undefined);
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.join('')).toBe('stralforsmcp-bridge: upstream error\n');
  });
});

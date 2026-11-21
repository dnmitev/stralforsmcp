// R-11: a client that drops the HTTP connection mid-call aborts the tool's upstream work (stateless transport).
import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { currentSignal } from '../stralfors/abort.ts';
import { CancelledError } from '../stralfors/errors.ts';
import { startHttp } from '../../test/helpers/http-harness.ts';
import { MCP_HEADERS, mkDef } from '../../test/helpers/server.ts';

const slow = mkDef('slow', 'read', async () => {
  const signal = currentSignal();
  await new Promise<void>((resolve, reject) => {
    if (!signal) return reject(new Error('no signal in scope'));
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve());
  });
  throw new CancelledError('request cancelled by the caller');
});
const CALL = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: {} } });

describe('HTTP connection closed mid-call', () => {
  it('aborts the tool scope and audits error/cancelled', async () => {
    const h = await startHttp({ tools: [slow] });
    const req = request({ host: '127.0.0.1', port: h.port, method: 'POST', path: '/mcp', headers: { ...MCP_HEADERS, host: 'mcp.example.test', authorization: `Bearer ${h.w.tA}`, 'content-length': Buffer.byteLength(CALL) } });
    req.on('error', () => undefined);
    req.end(CALL);
    await new Promise((r) => setTimeout(r, 150));
    req.destroy();
    await expect.poll(() => h.s.lines()).toEqual([expect.objectContaining({ outcome: 'error', reason: 'cancelled', tool: 'slow' })]);
  });
});

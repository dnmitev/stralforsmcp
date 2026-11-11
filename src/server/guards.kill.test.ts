/* Round 1 kill tests: refusal bodies, headers and the exact size boundary. */
import { describe, expect, it } from 'vitest';
import { refuse } from './guards.ts';

describe('refuse kill', () => {
  it('404 carries a fixed body and plain-text type', () => {
    expect(refuse({ method: 'POST', url: '/x' }, 10)).toEqual({ status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'not found' });
  });
  it('413 asks to close the connection, exactly at the limit passes', () => {
    expect(refuse({ method: 'POST', url: '/mcp', contentLength: '11' }, 10)).toEqual({
      status: 413, headers: { 'Content-Type': 'text/plain', Connection: 'close' }, body: 'payload too large',
    });
    expect(refuse({ method: 'POST', url: '/mcp', contentLength: '10' }, 10)).toBeUndefined();
    expect(refuse({ method: 'POST', url: '/mcp' }, 10)).toBeUndefined();
  });
});

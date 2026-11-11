/*
 * R27 instrument table. API under test (src/telemetry/instruments.ts): INSTRUMENTS, SECONDS, METHOD_LABEL, ALLOWED_SPAN_KEYS.
 * Pure data: no OTel import in the module.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALLOWED_SPAN_KEYS, INSTRUMENTS, METHOD_LABEL, SECONDS } from './instruments.ts';

const FORBIDDEN = ['userId', 'user_id', 'agreement', 'path', 'url', 'query', 'token', 'digest', 'traceId', 'trace_id', 'span_id', 'message'];

describe('INSTRUMENTS', () => {
  it('has exactly the eight instruments with their names, kinds, units and label keys', () => {
    const rows = Object.entries(INSTRUMENTS).map(([k, v]) => [k, v.name, v.kind, v.unit, [...v.keys]]);
    expect(rows).toEqual([
      ['httpDuration', 'http.server.request.duration', 'histogram', 's', ['http.request.method', 'http.response.status_code', 'http.route']],
      ['authRejections', 'mcp.auth.rejections', 'counter', '{request}', ['reason']],
      ['rateLimited', 'mcp.http.rate_limited', 'counter', '{request}', []],
      ['toolCalls', 'mcp.tool.calls', 'counter', '{call}', ['tool', 'outcome', 'env']],
      ['toolDuration', 'mcp.tool.duration', 'histogram', 's', ['tool', 'outcome']],
      ['upstreamRequests', 'stralfors.requests', 'counter', '{request}', ['operation', 'outcome', 'error.type']],
      ['upstreamDuration', 'stralfors.request.duration', 'histogram', 's', ['operation', 'outcome', 'error.type']],
      ['staleSeconds', 'mcp.token_list.stale_seconds', 'observable_gauge', 's', []],
    ]);
  });

  it('SECONDS is the 14 second-scale boundaries and every histogram uses it', () => {
    expect([...SECONDS]).toEqual([0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]);
    const hists = Object.values(INSTRUMENTS).filter((i) => i.kind === 'histogram');
    expect(hists).toHaveLength(3);
    for (const h of hists) expect((h as { buckets?: readonly number[] }).buckets).toBe(SECONDS);
    for (const i of Object.values(INSTRUMENTS).filter((x) => x.kind !== 'histogram')) expect('buckets' in i).toBe(false);
  });

  it('names are lower-case dotted, every instrument has a description, and no label key can carry an identifier', () => {
    for (const i of Object.values(INSTRUMENTS)) {
      expect(i.name).toMatch(/^[a-z][a-z0-9_.]*$/);
      expect(i.description.length).toBeGreaterThan(5);
      for (const k of i.keys) expect(FORBIDDEN).not.toContain(k);
    }
    expect(new Set(Object.values(INSTRUMENTS).map((i) => i.name)).size).toBe(8);
  });

  it('the module imports nothing (pure data, Stryker-friendly)', () => {
    const src = readFileSync(new URL('./instruments.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^import .*@opentelemetry/m);
  });
});

describe('METHOD_LABEL', () => {
  it.each([['POST', 'POST'], ['GET', 'GET'], ['HEAD', 'HEAD'], ['PUT', 'PUT'], ['DELETE', 'DELETE'], ['OPTIONS', 'OPTIONS'], ['PATCH', 'PATCH'], ['CONNECT', 'CONNECT'], ['TRACE', 'TRACE'],
    ['get', '_OTHER'], ['XCANARY', '_OTHER'], ['', '_OTHER'], [undefined, '_OTHER']])('%s -> %s', (m, out) => {
    expect(METHOD_LABEL(m)).toBe(out);
  });
});

describe('ALLOWED_SPAN_KEYS', () => {
  it('is exactly the eight span keys', () => {
    expect([...ALLOWED_SPAN_KEYS].sort()).toEqual(['env', 'error.type', 'http.request.method', 'http.response.status_code', 'http.route', 'outcome', 'stralfors.operation', 'tool']);
  });
});

// L3: a tool that needs a scope (requiredScope, or any write tool) must not be registered without claims; fail at construction, not silently per request.
import { describe, expect, it } from 'vitest';
import { buildMcp } from './mcp.ts';
import { registerAll } from './tools.ts';
import { McpServer } from '@modelcontextprotocol/server';
import { mkDef, okTool, sink, writeTool, principal } from '../../test/helpers/server.ts';

const base = () => ({ env: 'test' as const, allowWrite: true, prodValidateEnabled: false, audit: sink().audit });
const scoped = mkDef('scopedTool', 'read', async () => ({ v: 1 }), 'apiomni.read');
const claims = { hasScope: () => true };
const MSG = (n: string) => `tool ${n} needs a scope but claims are not wired`;

describe('buildMcp (registry factory) claims guard', () => {
  it('throws for a requiredScope tool without claims, naming only the tool', () => {
    expect(() => buildMcp({ ...base(), tools: [okTool, scoped] })).toThrow(MSG('scopedTool'));
  });
  it('throws for a write tool without claims', () => {
    expect(() => buildMcp({ ...base(), tools: [writeTool] })).toThrow(MSG('writeTool'));
  });
  it('is a ConfigError, so start() prints "refusing to start: ..."', async () => {
    const { ConfigError } = await import('../stralfors/errors.ts');
    expect(() => buildMcp({ ...base(), tools: [scoped] })).toThrow(ConfigError);
  });
  it('registers when claims are supplied', () => {
    expect(() => buildMcp({ ...base(), tools: [okTool, scoped, writeTool], claims } as never)).not.toThrow();
  });
  it('read tools without a scope are unaffected', () => {
    expect(() => buildMcp({ ...base(), tools: [okTool] })).not.toThrow();
  });
  it('a throw happens at construction, before any request', () => {
    let called = false;
    try { buildMcp({ ...base(), tools: [scoped] }); } catch { called = true; }
    expect(called).toBe(true);
  });
});

describe('registerAll claims guard', () => {
  it('throws the same message when called directly', () => {
    expect(() => registerAll(new McpServer({ name: 't', version: '0' }), principal('dev', ['test']), [scoped], base())).toThrow(MSG('scopedTool'));
  });
});

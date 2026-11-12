/*
 * R5 policy. API under test (src/policy/index.ts):
 *   decide({ principal, env, allowWrite, tool, claims? }): { allow: true } | { allow: false, reason: 'env'|'role'|'write'|'scope' }
 *   visibleTools(ctx, tools): ToolSpec[]; WRITE_SCOPE = 'apiomni.write'
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Principal, Role } from '../auth/index.ts';
import { Claims } from '../stralfors/token.ts';
import { WRITE_SCOPE, decide, visibleTools, type Access, type Decision, type ScopeHolder, type ToolSpec } from './index.ts';

type Env = 'test' | 'prod';
const scopes = (...s: string[]): ScopeHolder => ({ hasScope: (x) => s.includes(x) });
const who = (role: Role, envs: Env[]): Principal => ({ userId: 'u', name: 'n', role, envs });
const tool = (access: Access, requiredScope?: string): ToolSpec => ({ name: 't', access, ...(requiredScope ? { requiredScope } : {}) });

// Independent oracle: written from the rule table, not from src/policy.
function oracle(p: Principal, env: Env, allowWrite: boolean, t: ToolSpec, claims?: ScopeHolder): Decision {
  if (!p.envs.includes(env)) return { allow: false, reason: 'env' };
  if (env === 'prod' && p.role !== 'dev') return { allow: false, reason: 'role' };
  if (t.access === 'write' && env === 'prod') return { allow: false, reason: 'write' };
  if (t.access === 'write' && !allowWrite) return { allow: false, reason: 'write' };
  const need = t.requiredScope ?? (t.access === 'write' ? 'apiomni.write' : undefined);
  if (need !== undefined && !(claims?.hasScope(need) ?? false)) return { allow: false, reason: 'scope' };
  return { allow: true };
}

const roles: Role[] = ['dev', 'qa', 'pm'];
const envs: Env[] = ['test', 'prod'];
const accesses: Access[] = ['read', 'validate', 'write'];
const reqs = [undefined, 'apiomni.read', 'other.scope'];
const claimSets: (ScopeHolder | undefined)[] = [undefined, scopes('apiomni.read'), scopes('apiomni.read', 'apiomni.write')];

const combos = () => {
  const out: Parameters<typeof decide>[0][] = [];
  for (const role of roles) for (const env of envs) for (const access of accesses) for (const allowWrite of [true, false])
    for (const member of [true, false]) for (const rs of reqs) for (const claims of claimSets) {
      const other: Env = env === 'test' ? 'prod' : 'test';
      out.push({ principal: who(role, member ? [env] : [other]), env, allowWrite, prodValidateEnabled: true, tool: tool(access, rs), claims });
    }
  return out;
};

describe('R5 policy matrix', () => {
  const all = combos();
  it(`exhaustive generated matrix: ${all.length} combinations equal the oracle`, () => {
    expect(all).toHaveLength(648);
    for (const c of all) expect(decide(c), JSON.stringify({ ...c, claims: !!c.claims })).toEqual(oracle(c.principal, c.env, c.allowWrite, c.tool, c.claims));
  });

  it.each([
    ['dev', ['test'], 'test', false, 'read', [], 'allow'],
    ['qa', ['test'], 'test', false, 'validate', [], 'allow'],
    ['pm', ['test'], 'test', false, 'validate', [], 'allow'],
    ['pm', ['test'], 'test', true, 'write', [WRITE_SCOPE], 'allow'],
    ['pm', ['test'], 'test', false, 'write', [WRITE_SCOPE], 'write'],
    ['pm', ['test'], 'test', true, 'write', ['apiomni.read'], 'scope'],
    ['dev', ['test', 'prod'], 'prod', false, 'read', [], 'allow'],
    ['dev', ['test', 'prod'], 'prod', false, 'validate', [], 'allow'],
    ['dev', ['test', 'prod'], 'prod', true, 'write', [WRITE_SCOPE], 'write'],
    ['qa', ['test', 'prod'], 'prod', false, 'read', [], 'role'],
    ['pm', ['test', 'prod'], 'prod', false, 'read', [], 'role'],
    ['dev', ['test'], 'prod', false, 'read', [], 'env'],
    ['qa', ['prod'], 'test', false, 'read', [], 'env'],
  ] as [Role, Env[], Env, boolean, Access, string[], string][])('%s %j in %s allowWrite=%s %s -> %s', (role, e, env, aw, access, sc, result) => {
    const d = decide({ principal: who(role, e), env, allowWrite: aw, prodValidateEnabled: true, tool: tool(access), claims: scopes(...sc) });
    expect(d).toEqual(result === 'allow' ? { allow: true } : { allow: false, reason: result });
  });

  it('prod write denial does not depend on allowWrite or scope', () => {
    expect(decide({ principal: who('dev', ['test', 'prod']), env: 'prod', allowWrite: true, prodValidateEnabled: true, tool: tool('write'), claims: scopes(WRITE_SCOPE) })).toEqual({ allow: false, reason: 'write' });
  });

  it('reason precedence env > role > write > scope', () => {
    const t = tool('write');
    expect(decide({ principal: who('pm', ['test']), env: 'prod', allowWrite: false, prodValidateEnabled: true, tool: t })).toEqual({ allow: false, reason: 'env' });
    expect(decide({ principal: who('pm', ['test', 'prod']), env: 'prod', allowWrite: false, prodValidateEnabled: true, tool: t })).toEqual({ allow: false, reason: 'role' });
    expect(decide({ principal: who('dev', ['test', 'prod']), env: 'prod', allowWrite: false, prodValidateEnabled: true, tool: t })).toEqual({ allow: false, reason: 'write' });
    expect(decide({ principal: who('dev', ['test']), env: 'test', allowWrite: false, prodValidateEnabled: true, tool: t })).toEqual({ allow: false, reason: 'write' });
  });
});

describe('R5 scope and visibility', () => {
  const dev = who('dev', ['test', 'prod']);
  it('explicit requiredScope is checked in every env', () => {
    for (const env of envs) expect(decide({ principal: dev, env, allowWrite: false, prodValidateEnabled: true, tool: tool('validate', WRITE_SCOPE), claims: scopes('apiomni.read') })).toEqual({ allow: false, reason: 'scope' });
  });
  it('write tool needs apiomni.write even in test', () => {
    expect(decide({ principal: dev, env: 'test', allowWrite: true, prodValidateEnabled: true, tool: tool('write'), claims: scopes('apiomni.read') })).toEqual({ allow: false, reason: 'scope' });
  });
  it('explicit requiredScope replaces the implicit write scope', () => {
    expect(decide({ principal: dev, env: 'test', allowWrite: true, prodValidateEnabled: true, tool: tool('write', 'custom.send'), claims: scopes('custom.send') })).toEqual({ allow: true });
  });
  it('no claims fails closed only when a scope is required', () => {
    expect(decide({ principal: dev, env: 'test', allowWrite: false, prodValidateEnabled: true, tool: tool('read') })).toEqual({ allow: true });
    expect(decide({ principal: dev, env: 'test', allowWrite: false, prodValidateEnabled: true, tool: tool('read', 'apiomni.read') })).toEqual({ allow: false, reason: 'scope' });
  });

  const tools: ToolSpec[] = [{ name: 'r', access: 'read' }, { name: 'v', access: 'validate', requiredScope: 'apiomni.read' }, { name: 'w', access: 'write' }, { name: 'x', access: 'read', requiredScope: 'other' }];
  const names = (ctx: Parameters<typeof visibleTools>[0]) => visibleTools(ctx, tools).map((t) => t.name);
  const claims = scopes('apiomni.read', 'apiomni.write');
  it('visibleTools filters and keeps order', () => {
    const before = structuredClone(tools);
    expect(names({ principal: dev, env: 'test', allowWrite: true, prodValidateEnabled: true, claims })).toEqual(['r', 'v', 'w']);
    expect(names({ principal: dev, env: 'test', allowWrite: false, prodValidateEnabled: true, claims })).toEqual(['r', 'v']);
    expect(names({ principal: dev, env: 'prod', allowWrite: false, prodValidateEnabled: true, claims })).toEqual(['r', 'v']);
    expect(names({ principal: who('pm', ['test', 'prod']), env: 'prod', allowWrite: false, prodValidateEnabled: true, claims })).toEqual([]);
    expect(tools).toEqual(before);
  });

  it('Claims satisfies ScopeHolder (no new Claims API)', () => {
    expectTypeOf<Claims>().toExtend<ScopeHolder>();
    expect(visibleTools({ principal: dev, env: 'test', allowWrite: false, prodValidateEnabled: true, claims: new Claims({ scope: 'apiomni.read' }) }, tools).map((t) => t.name)).toEqual(['r', 'v']);
  });
});

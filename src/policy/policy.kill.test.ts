// Mutation-hardening for src/policy/policy.ts: each rule row in isolation, results carry no extra keys, decide never throws.
import { describe, expect, it } from 'vitest';
import type { Principal } from '../auth/index.ts';
import { decide, visibleTools } from './index.ts';

const p = (role: Principal['role'], envs: Principal['envs']): Principal => ({ userId: 'u', name: 'n', role, envs });
const yes = { hasScope: () => true };
const no = { hasScope: () => false };

describe('rule rows in isolation', () => {
  it('row 1: membership only (role and scope would pass)', () => {
    expect(decide({ principal: p('dev', ['prod']), env: 'test', allowWrite: false, tool: { name: 't', access: 'read' }, claims: yes })).toStrictEqual({ allow: false, reason: 'env' });
  });
  it('row 2: role only in prod, not in test', () => {
    expect(decide({ principal: p('qa', ['test', 'prod']), env: 'prod', allowWrite: false, tool: { name: 't', access: 'read' } })).toStrictEqual({ allow: false, reason: 'role' });
    expect(decide({ principal: p('qa', ['test', 'prod']), env: 'test', allowWrite: false, tool: { name: 't', access: 'read' } })).toStrictEqual({ allow: true });
  });
  it('row 3/4: write denied by constant in prod and by flag in test; not for validate', () => {
    const dev = p('dev', ['test', 'prod']);
    expect(decide({ principal: dev, env: 'prod', allowWrite: true, tool: { name: 't', access: 'write' }, claims: yes })).toStrictEqual({ allow: false, reason: 'write' });
    expect(decide({ principal: dev, env: 'test', allowWrite: false, tool: { name: 't', access: 'write' }, claims: yes })).toStrictEqual({ allow: false, reason: 'write' });
    expect(decide({ principal: dev, env: 'test', allowWrite: true, tool: { name: 't', access: 'write' }, claims: yes })).toStrictEqual({ allow: true });
    expect(decide({ principal: dev, env: 'prod', allowWrite: false, tool: { name: 't', access: 'validate' } })).toStrictEqual({ allow: true });
  });
  it('row 5: scope uses hasScope with the exact required name', () => {
    const seen: string[] = [];
    const claims = { hasScope: (s: string) => (seen.push(s), false) };
    const dev = p('dev', ['test']);
    decide({ principal: dev, env: 'test', allowWrite: true, tool: { name: 't', access: 'write' }, claims });
    decide({ principal: dev, env: 'test', allowWrite: true, tool: { name: 't', access: 'write', requiredScope: 'c.s' }, claims });
    expect(seen).toEqual(['apiomni.write', 'c.s']);
    expect(decide({ principal: dev, env: 'test', allowWrite: false, tool: { name: 't', access: 'read' }, claims: no })).toStrictEqual({ allow: true });
  });
  it('an empty requiredScope string is still a requirement', () => {
    expect(decide({ principal: p('dev', ['test']), env: 'test', allowWrite: false, tool: { name: 't', access: 'read', requiredScope: '' }, claims: no })).toStrictEqual({ allow: false, reason: 'scope' });
  });
  it('visibleTools returns the tool objects themselves, and [] for []', () => {
    const t = { name: 'a', access: 'read' as const };
    expect(visibleTools({ principal: p('dev', ['test']), env: 'test', allowWrite: false }, [t])[0]).toBe(t);
    expect(visibleTools({ principal: p('dev', ['test']), env: 'test', allowWrite: false }, [])).toEqual([]);
  });
});

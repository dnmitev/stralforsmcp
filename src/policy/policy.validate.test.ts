// L2: prodValidateEnabled in the policy. Rule order: env, role, write, validate, scope.
import { describe, expect, it } from 'vitest';
import type { Principal, Role } from '../auth/index.ts';
import { decide, visibleTools, type Access, type DenyReason } from './index.ts';

type Env = 'test' | 'prod';
const p = (role: Role, envs: Env[]): Principal => ({ userId: 'u', name: 'n', role, envs });
const yes = { hasScope: () => true };
const no = { hasScope: () => false };
const t = (access: Access, requiredScope?: string) => ({ name: 't', access, ...(requiredScope ? { requiredScope } : {}) });

describe('decide: env x role x prodValidateEnabled x access (oracle from the rule table)', () => {
  const oracle = (role: Role, env: Env, pv: boolean, access: Access): DenyReason | undefined => {
    if (env === 'prod' && role !== 'dev') return 'role';
    if (access === 'write' && env === 'prod') return 'write';
    if (access === 'validate' && env === 'prod' && !pv) return 'validate';
    return undefined;
  };
  for (const role of ['dev', 'qa', 'pm'] as Role[]) for (const env of ['test', 'prod'] as Env[]) for (const pv of [true, false]) for (const access of ['read', 'validate', 'write'] as Access[]) {
    it(`${role} ${env} prodValidateEnabled=${pv} ${access}`, () => {
      const reason = oracle(role, env, pv, access);
      expect(decide({ principal: p(role, ['test', 'prod']), env, allowWrite: true, prodValidateEnabled: pv, tool: t(access), claims: yes }))
        .toStrictEqual(reason ? { allow: false, reason } : { allow: true });
    });
  }
});

describe('validate rule', () => {
  const dev = p('dev', ['test', 'prod']);
  it('denied in prod when off, with the new reason', () => {
    expect(decide({ principal: dev, env: 'prod', allowWrite: false, prodValidateEnabled: false, tool: t('validate'), claims: yes })).toStrictEqual({ allow: false, reason: 'validate' });
  });
  it('allowed in prod when on (dev, scope held)', () => {
    expect(decide({ principal: dev, env: 'prod', allowWrite: false, prodValidateEnabled: true, tool: t('validate'), claims: yes })).toStrictEqual({ allow: true });
  });
  it('unaffected in test, whatever the flag', () => {
    for (const pv of [true, false]) expect(decide({ principal: dev, env: 'test', allowWrite: false, prodValidateEnabled: pv, tool: t('validate') })).toStrictEqual({ allow: true });
  });
  it('read tools unaffected in prod when off', () => {
    expect(decide({ principal: dev, env: 'prod', allowWrite: false, prodValidateEnabled: false, tool: t('read') })).toStrictEqual({ allow: true });
  });
});

describe('rule order around validate', () => {
  const dev = p('dev', ['test', 'prod']);
  it('env beats validate', () => {
    expect(decide({ principal: p('dev', ['test']), env: 'prod', allowWrite: false, prodValidateEnabled: false, tool: t('validate') })).toStrictEqual({ allow: false, reason: 'env' });
  });
  it('role beats validate (also when the flag is on)', () => {
    for (const pv of [true, false]) expect(decide({ principal: p('qa', ['prod']), env: 'prod', allowWrite: false, prodValidateEnabled: pv, tool: t('validate') })).toStrictEqual({ allow: false, reason: 'role' });
  });
  it('write beats validate: a write tool in prod is never reported as validate', () => {
    expect(decide({ principal: dev, env: 'prod', allowWrite: false, prodValidateEnabled: false, tool: t('write') })).toStrictEqual({ allow: false, reason: 'write' });
  });
  it('validate beats scope: flag off and scope missing reports validate; flag on and scope missing reports scope', () => {
    expect(decide({ principal: dev, env: 'prod', allowWrite: false, prodValidateEnabled: false, tool: t('validate', 'x'), claims: no })).toStrictEqual({ allow: false, reason: 'validate' });
    expect(decide({ principal: dev, env: 'prod', allowWrite: false, prodValidateEnabled: true, tool: t('validate', 'x'), claims: no })).toStrictEqual({ allow: false, reason: 'scope' });
  });
});

describe('visibleTools', () => {
  const tools = [{ name: 'r', access: 'read' as const }, { name: 'v', access: 'validate' as const }, { name: 'w', access: 'write' as const }];
  const dev = p('dev', ['test', 'prod']);
  it('hides validate in prod when off, shows it when on', () => {
    expect(visibleTools({ principal: dev, env: 'prod', allowWrite: false, prodValidateEnabled: false, claims: yes }, tools).map((x) => x.name)).toEqual(['r']);
    expect(visibleTools({ principal: dev, env: 'prod', allowWrite: false, prodValidateEnabled: true, claims: yes }, tools).map((x) => x.name)).toEqual(['r', 'v']);
  });
  it('test env keeps validate with the flag off', () => {
    expect(visibleTools({ principal: dev, env: 'test', allowWrite: false, prodValidateEnabled: false, claims: yes }, tools).map((x) => x.name)).toEqual(['r', 'v']);
  });
});

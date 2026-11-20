/*
 * 05-04a Task 2 (AEGIS R-03): resources and prompts follow the same env/role policy as a read tool.
 * A principal denied every read tool gets neither capability; the knowledge overlay cannot be read through a side door.
 */
import { describe, expect, it } from 'vitest';
import type { Env, Role } from '../auth/index.ts';
import { ERAS, connect, handlerFetch, principal, sink, toAuth } from '../../test/helpers/server.ts';
import type { KnowledgeDoc } from '../knowledge/index.ts';
import { buildMcp } from './mcp.ts';

const docs: KnowledgeDoc[] = [{ id: 'team-notes', title: 'Team notes', source: 'private', tags: [], body: 'PRIVATEBODY internal notes.' }];
const URI = 'knowledge://docs/team-notes';

const setup = async (era: (typeof ERAS)[number], env: Env, role: Role, envs: Env[]) => {
  const s = sink();
  const { fetch } = handlerFetch(buildMcp({ env, allowWrite: false, prodValidateEnabled: false, audit: s.audit, tools: [], knowledge: { docs } }), toAuth(principal(role, envs)));
  return { s, c: await connect(era, fetch) };
};
const ROWS: { role: Role; env: Env; envs: Env[]; allowed: boolean }[] = [
  { role: 'dev', env: 'prod', envs: ['prod'], allowed: true },
  { role: 'dev', env: 'test', envs: ['test'], allowed: true },
  { role: 'pm', env: 'test', envs: ['test'], allowed: true },
  { role: 'qa', env: 'prod', envs: ['prod'], allowed: false }, // PROD is dev-only
  { role: 'pm', env: 'prod', envs: ['prod'], allowed: false },
  { role: 'dev', env: 'prod', envs: ['test'], allowed: false }, // env not granted to this principal
  { role: 'pm', env: 'test', envs: ['prod'], allowed: false },
];

describe.each(ERAS)('knowledge surfaces follow the read policy (%s)', (era) => {
  it.each(ROWS)('$role envs=$envs env=$env -> allowed=$allowed', async ({ role, env, envs, allowed }) => {
    const { s, c } = await setup(era, env, role, envs);
    const caps = c.getServerCapabilities() as { resources?: unknown; prompts?: unknown };
    expect(Boolean(caps.resources)).toBe(allowed);
    expect(Boolean(caps.prompts)).toBe(allowed);
    const resources = await c.listResources().then((r) => r.resources, () => []);
    const prompts = await c.listPrompts().then((r) => r.prompts, () => []);
    expect(resources.length > 0).toBe(allowed);
    expect(prompts.length > 0).toBe(allowed);
    const read = await c.readResource({ uri: URI }).then((r) => JSON.stringify(r), (e: unknown) => `ERR ${(e as Error).message}`);
    if (allowed) expect(read).toContain('PRIVATEBODY');
    else {
      expect(read).toMatch(/^ERR/);
      expect(read).not.toContain('PRIVATEBODY');
    }
    const got = await c.getPrompt({ name: 'explain_channel', arguments: { channel: 'EDI' } }).then(() => true, () => false);
    expect(got).toBe(allowed);
    if (!allowed) expect(s.lines()).toEqual([]); // a denied principal reaches no callback, so nothing is audited
  });
});

import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { hashToken, parseTokenList } from '../src/auth/index.ts';
import { main } from './token.ts';

const NOW = Date.parse('2030-01-10T00:00:00.000Z');
let n = 0;
const gen = () => `smcp_${String(++n).padStart(43, 'B')}`;

function setup(lines?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'token-cli-'));
  const file = join(dir, 'token-list.json');
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    now: () => NOW,
    gen,
    ...(lines && { input: Readable.from(lines.map((l) => `${l}\n`)) }),
  };
  const run = (...args: string[]) => main([...args, '--file', file], io);
  return { dir, file, out, err, io, run };
}

describe('npm run token (flags)', () => {
  it('refuses role SA and writes nothing', async () => {
    const t = setup();
    expect(await t.run('add-user', '--id', 'a', '--name', 'A', '--role', 'SA', '--env', 'test')).toBe(1);
    expect(t.err.join('\n')).toContain('--role must be one of: dev, qa, pm');
    expect(existsSync(t.file)).toBe(false);
  });

  it('refuses env stage, days 91, missing flags and unknown flags', async () => {
    const t = setup();
    expect(await t.run('add-user', '--id', 'a', '--name', 'A', '--role', 'dev', '--env', 'stage')).toBe(1);
    expect(await t.run('add-user', '--id', 'a', '--name', 'A', '--role', 'dev')).toBe(1);
    expect(await t.run('add-user', '--name', 'A', '--role', 'dev', '--env', 'test')).toBe(1);
    expect(t.err.join('\n')).toContain('--id is required');
    expect(await t.run('add-user', '--id', 'a', '--name', 'A', '--role', 'dev', '--env', 'test')).toBe(0);
    expect(await t.run('issue', '--user', 'a', '--days', '91')).toBe(1);
    expect(await t.run('list', '--bogus')).toBe(1);
    expect(await t.run('nope')).toBe(1);
    expect(parseTokenList(readFileSync(t.file, 'utf8')).tokens).toHaveLength(0);
  });

  it('refuses an invalid existing file with the server message and leaves it untouched', async () => {
    const t = setup();
    const bad = JSON.stringify({ users: [{ id: '1', name: 'X', role: 'SA', envs: ['test'] }], tokens: [] });
    writeFileSync(t.file, bad);
    expect(await t.run('add-user', '--id', 'b', '--name', 'B', '--role', 'dev', '--env', 'test')).toBe(2);
    expect(await t.run('list')).toBe(2);
    expect(t.err.join('\n')).toContain('token list: users[0].role is invalid');
    expect(readFileSync(t.file, 'utf8')).toBe(bad);
  });

  it('add-user -> issue -> list -> revoke -> prune, 0600, raw token once on stderr only', async () => {
    const t = setup();
    expect(await t.run('add-user', '--id', 'alice', '--name', 'Alice', '--role', 'qa', '--env', 'test', '--env', 'prod')).toBe(0);
    expect(await t.run('issue', '--user', 'alice', '--days', '1')).toBe(0);
    const raw = t.err.join('\n').match(/smcp_\S+/)![0];
    const list = parseTokenList(readFileSync(t.file, 'utf8'));
    expect(list.users[0]).toMatchObject({ role: 'qa', envs: ['test', 'prod'] });
    expect(list.tokens[0]!.hash).toBe(hashToken(raw));
    expect(statSync(t.file).mode & 0o777).toBe(0o600);
    const id = list.tokens[0]!.hash.slice(0, 8);

    t.out.length = 0;
    expect(await t.run('list')).toBe(0);
    const shown = t.out.join('\n');
    expect(shown).toContain(id);
    expect(shown).toContain('active');
    expect(shown).not.toContain(list.tokens[0]!.hash);
    expect(shown).not.toContain(raw);

    expect(await t.run('revoke', '--token', id)).toBe(0);
    expect(parseTokenList(readFileSync(t.file, 'utf8')).tokens[0]!.revoked).toBe(true);
    expect(await t.run('revoke')).toBe(1);
    expect(await t.run('prune', '--users')).toBe(0); // not yet expired: kept
    expect(parseTokenList(readFileSync(t.file, 'utf8')).tokens).toHaveLength(1);
    expect(t.out.join('\n').match(/smcp_/g)).toBeNull();
    expect(t.err.join('\n').match(/smcp_/g)).toHaveLength(1);
  });

  it('set-user changes access; access prints the policy table; --help prints usage', async () => {
    const t = setup();
    await t.run('add-user', '--id', 'a', '--name', 'A', '--role', 'pm', '--env', 'test');
    expect(await t.run('set-user', '--id', 'a', '--role', 'dev', '--env', 'prod')).toBe(0);
    expect(parseTokenList(readFileSync(t.file, 'utf8')).users[0]).toMatchObject({ role: 'dev', envs: ['prod'] });
    expect(await t.run('set-user', '--id', 'a', '--role', 'SA')).toBe(1);
    t.out.length = 0;
    expect(await t.run('access')).toBe(0);
    expect(t.out.join('\n')).toMatch(/qa\s+prod\s+no \(role\)/);
    expect(await t.run('--help')).toBe(0);
    expect(t.out.join('\n')).toContain('usage: npm run token');
  });
});

describe('npm run token (wizard)', () => {
  it('re-asks on invalid choices and writes a valid user + token', async () => {
    const t = setup(['1', 'bob', 'Bob Builder', 'SA', '9', '2', 'stage', 'test', '91', '14', '8']);
    expect(await main(['--file', t.file], t.io)).toBe(0);
    const list = parseTokenList(readFileSync(t.file, 'utf8'));
    expect(list.users).toEqual([{ id: 'bob', name: 'Bob Builder', role: 'qa', envs: ['test'] }]);
    expect(Date.parse(list.tokens[0]!.expires) - NOW).toBe(14 * 86_400_000);
    const e = t.err.join('\n');
    expect(e).toContain('choose 1-3');
    expect(e).toContain('--env must be one or more of: test, prod');
    expect(e).toContain('--days must be a whole number from 1 to 90');
    expect(e.match(/smcp_/g)).toHaveLength(1);
  });

  it('stops cleanly when input ends and never writes a partial user', async () => {
    const t = setup(['1', 'carol']);
    expect(await main(['--file', t.file], t.io)).toBe(1);
    expect(existsSync(t.file)).toBe(false);
  });

  it('refuses to start on an invalid existing file', async () => {
    const t = setup(['8']);
    writeFileSync(t.file, '{"users":[],"tokens":[],"x":1}');
    expect(await main(['--file', t.file], t.io)).toBe(2);
    expect(t.err.join('\n')).toContain('token list: (root) has unknown key');
  });
});

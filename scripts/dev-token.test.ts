import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { createTokenStore, hashToken, TOKEN_RE } from '../src/auth/index.ts';
import { writeDevToken } from './dev-token.ts';

const dir = mkdtempSync(join(tmpdir(), 'devtok-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('dev-token', () => {
  it('writes a valid list holding only the hash, and returns a token that verifies', () => {
    const p = join(dir, 'a.json');
    const raw = writeDevToken(p, false);
    const text = readFileSync(p, 'utf8');
    expect(raw).toMatch(TOKEN_RE);
    expect(text).not.toContain(raw);
    expect(text).toContain(hashToken(raw));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const store = createTokenStore({ read: () => text, now: Date.now });
    const r = store.verify(raw);
    store.close();
    expect(r).toMatchObject({ ok: true, principal: { role: 'dev', envs: ['test'] } });
    if (r.ok) expect(Math.round((r.expiresAt - Date.now()) / 864e5)).toBe(30);
  });

  it('refuses to overwrite without force, replaces with it', () => {
    const p = join(dir, 'b.json');
    writeFileSync(p, 'keep');
    expect(() => writeDevToken(p, false)).toThrow(/--force/);
    expect(readFileSync(p, 'utf8')).toBe('keep');
    writeDevToken(p, true);
    expect(readFileSync(p, 'utf8')).not.toBe('keep');
  });

  it('cli: token on stderr only, honours MCP_TOKEN_LIST_FILE, exits 1 on existing file', () => {
    const p = join(dir, 'c.json');
    const run = () => spawnSync(process.execPath, ['scripts/dev-token.ts'], { env: { ...process.env, MCP_TOKEN_LIST_FILE: p }, encoding: 'utf8' });
    const a = run();
    expect(a.status).toBe(0);
    expect(a.stdout).toBe('');
    const raw = /smcp_[A-Za-z0-9_-]{43}/.exec(a.stderr)?.[0];
    expect(raw).toBeDefined();
    expect(readFileSync(p, 'utf8')).toContain(hashToken(raw!));
    const b = run();
    expect(b.status).toBe(1);
    expect(b.stderr).toMatch(/--force/);
  });
});

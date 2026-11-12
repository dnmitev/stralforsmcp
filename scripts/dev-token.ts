import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateToken, hashToken, type TokenList } from '../src/auth/index.ts';

const DAY = 86_400_000;

/** One dev user (role dev, env test) and one 30-day token. Only the hash goes in the list; the raw token is returned for the caller to show once. */
export function devTokenList(now = Date.now()): { raw: string; list: TokenList } {
  const raw = generateToken();
  const list: TokenList = {
    users: [{ id: 'dev', name: 'Local dev', role: 'dev', envs: ['test'] }],
    tokens: [{ hash: hashToken(raw), userId: 'dev', created: new Date(now).toISOString(), expires: new Date(now + 30 * DAY).toISOString() }],
  };
  return { raw, list };
}

/** Writes the list (mode 600) and returns the raw token; refuses to replace an existing file without force. */
export function writeDevToken(path: string, force: boolean, now?: number): string {
  if (!force && existsSync(path)) throw new Error('token list exists; pass --force to replace it');
  const { raw, list } = devTokenList(now);
  writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  return raw;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const path = resolve(process.env.MCP_TOKEN_LIST_FILE || './token-list.json');
    const raw = writeDevToken(path, process.argv.includes('--force'));
    process.stderr.write(`wrote ${path}\ntoken (shown once, keep private): ${raw}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : 'failed'}\n`);
    process.exitCode = 1;
  }
}

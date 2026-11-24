// `npm run token` — manage the token list without hand-editing JSON.
//   npm run token                       interactive wizard
//   npm run token -- <command> [flags]  scriptable (see USAGE)
// Every write is checked with the server's own parser first; an invalid existing file is refused, never changed.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { ENVS, parseTokenList, ROLES, type TokenList } from '../src/auth/index.ts';
import {
  accessTable, addUser, emptyList, InputError, issueToken, listView, parseDays, parseEnvs, parseRole, prune, revokeToken, revokeUser, setUser,
} from '../src/admin/token-list.ts';
import { ConfigError } from '../src/stralfors/errors.ts';

export const USAGE = `usage: npm run token -- [command] [--file token-list.json] [flags]
  (no command)                                   interactive wizard
  add-user  --id ID --name NAME --role ${ROLES.join('|')} --env ${ENVS.join('|')} [--env ...]
  set-user  --id ID [--name NAME] [--role ROLE] [--env ENV ...]
  issue     --user ID [--days 1-90, default 30]
  list
  revoke    --token TOKEN_ID | --user ID
  prune     [--older-than-days N] [--users]
  access                                         what each role may call per environment`;

class InputClosed extends Error {}

const RELOAD_NOTE = 'saved. The server re-reads the list within about 60 s; a revocation can take about 2 minutes (restart the pods to apply it at once).';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  input?: NodeJS.ReadableStream;
  now?: () => number;
  gen?: () => string;
}

function load(path: string): TokenList {
  return existsSync(path) ? parseTokenList(readFileSync(path, 'utf8')) : emptyList();
}

/** New 0600 file beside the target, renamed over it: never a half-written list, never a looser inherited mode. */
function save(path: string, list: TokenList): void {
  const text = `${JSON.stringify(parseTokenList(JSON.stringify(list)), null, 2)}\n`;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

const pad = (s: string, n: number) => s.padEnd(n);

function printList(list: TokenList, now: number, out: Io['out']): void {
  const v = listView(list, now);
  out('users:');
  if (!v.users.length) out('  (none)');
  for (const u of v.users) out(`  ${pad(u.id, 16)} ${pad(u.role, 4)} ${pad(u.envs.join(','), 10)} active tokens: ${u.active}  ${u.name}`);
  out('tokens:');
  if (!v.tokens.length) out('  (none)');
  for (const t of v.tokens) out(`  ${t.id}  ${pad(t.userId, 16)} ${pad(t.state, 8)} expires ${t.expires}`);
}

function printAccess(out: Io['out']): void {
  out('access per role and environment (the user also needs that environment in --env):');
  out(`  ${pad('role', 5)}${pad('env', 6)}${pad('read', 11)}${pad('validate', 49)}${pad('write', 40)}lookup`);
  for (const role of ROLES) for (const env of ENVS) {
    const r = (a: string) => accessTable().find((x) => x.role === role && x.env === env && x.access === a)!.result;
    out(`  ${pad(role, 5)}${pad(env, 6)}${pad(r('read'), 11)}${pad(r('validate'), 49)}${pad(r('write'), 40)}${r('lookup')}`);
  }
  out('  read = whoami, list_channels, get_rules, get_example_invoice, track_document, search_docs; validate = validate_invoice;');
  out('  write = send_invoice (test only); lookup = channel_lookup (test only). Stralfors scopes of the profile apply on top.');
}

function issued(io: Io, r: { raw: string; id: string }): void {
  io.err(`token id ${r.id} (shown once, give it to the user over a private channel): ${r.raw}`);
}

const need = (v: string | undefined, flag: string): string => {
  if (v === undefined) throw new InputError(`${flag} is required`);
  return v;
};

function runCommand(cmd: string, f: Record<string, string | string[] | boolean | undefined>, path: string, io: Io, now: number): void {
  const s = (k: string) => f[k] as string | undefined;
  const envs = f['env'] as string[] | undefined;
  let list = load(path);
  switch (cmd) {
    case 'list':
      printList(list, now, io.out);
      return;
    case 'access':
      printAccess(io.out);
      return;
    case 'add-user':
      list = addUser(list, { id: need(s('id'), '--id'), name: need(s('name'), '--name'), role: parseRole(need(s('role'), '--role')), envs: parseEnvs(envs ?? []) });
      break;
    case 'set-user': {
      const role = s('role');
      list = setUser(list, need(s('id'), '--id'), { name: s('name'), role: role === undefined ? undefined : parseRole(role), envs: envs === undefined ? undefined : parseEnvs(envs) });
      break;
    }
    case 'issue': {
      const r = issueToken(list, need(s('user'), '--user'), parseDays(s('days')), now, io.gen);
      list = r.list;
      save(path, list);
      issued(io, r);
      io.out(RELOAD_NOTE);
      return;
    }
    case 'revoke': {
      const t = s('token');
      const u = s('user');
      if ((t === undefined) === (u === undefined)) throw new InputError('revoke needs exactly one of --token or --user');
      const r = t !== undefined ? revokeToken(list, t) : revokeUser(list, u!);
      list = r.list;
      io.out(`revoked ${r.count} token(s)`);
      break;
    }
    case 'prune': {
      const d = s('older-than-days');
      if (d !== undefined && !/^\d+$/.test(d)) throw new InputError('--older-than-days must be a whole number');
      const r = prune(list, { olderThanDays: d === undefined ? 0 : Number(d), users: f['users'] === true }, now);
      list = r.list;
      io.out(`removed ${r.tokens} token(s) and ${r.users} user(s)`);
      break;
    }
    default:
      throw new InputError(`unknown command ${cmd}\n${USAGE}`);
  }
  save(path, list);
  io.out(RELOAD_NOTE);
}

async function wizard(path: string, io: Io, now: number): Promise<void> {
  // Lines are read through the async iterator, which buffers: piped input is never dropped between prompts.
  const rl = createInterface({ input: io.input ?? process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q: string): Promise<string> => {
    process.stderr.write(`${q} `);
    const r = await lines.next();
    if (r.done) throw new InputClosed();
    return String(r.value).trim();
  };
  const choose = async <T extends string>(q: string, opts: readonly T[]): Promise<T> => {
    for (;;) {
      io.out(`${q}\n${opts.map((o, i) => `  ${i + 1}) ${o}`).join('\n')}`);
      const a = await ask('>');
      const i = Number(a) - 1;
      if (Number.isInteger(i) && opts[i] !== undefined) return opts[i]!;
      if ((opts as readonly string[]).includes(a)) return a as T;
      io.err(`choose 1-${opts.length}`);
    }
  };
  const retry = async <T>(f: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await f();
      } catch (e) {
        if (!(e instanceof InputError)) throw e;
        io.err(e.message);
      }
    }
  };
  const pickEnvs = () => retry(async () => parseEnvs((await ask(`environments (${ENVS.join(', ')}; comma-separated) [test]:`) || 'test').split(',').map((x) => x.trim()).filter(Boolean)));
  const pickUser = async (list: TokenList) => {
    if (!list.users.length) throw new InputError('no users yet: add one first');
    return choose('user:', list.users.map((u) => u.id));
  };
  try {
    for (;;) {
      let list = load(path);
      const what = await choose(`token list ${path}`, ['add user and issue token', 'issue token', 'list', 'revoke', 'change user access', 'prune expired', 'show access', 'quit'] as const);
      try {
        if (what === 'quit') return;
        if (what === 'list') { printList(list, now, io.out); continue; }
        if (what === 'show access') { printAccess(io.out); continue; }
        if (what === 'add user and issue token') {
          const id = await retry(async () => { const v = await ask('user id:'); if (!v) throw new InputError('--id must not be empty'); if (list.users.some((u) => u.id === v)) throw new InputError(`user ${v} already exists`); return v; });
          const name = await retry(async () => { const v = await ask('full name:'); if (!v) throw new InputError('--name must not be empty'); return v; });
          printAccess(io.out);
          const role = await choose('role:', ROLES);
          list = addUser(list, { id, name, role, envs: await pickEnvs() });
          const days = await retry(async () => parseDays((await ask('days valid (1-90) [30]:')) || undefined));
          const r = issueToken(list, id, days, now, io.gen);
          save(path, r.list);
          issued(io, r);
        } else if (what === 'issue token') {
          const id = await pickUser(list);
          const days = await retry(async () => parseDays((await ask('days valid (1-90) [30]:')) || undefined));
          const r = issueToken(list, id, days, now, io.gen);
          save(path, r.list);
          issued(io, r);
        } else if (what === 'revoke') {
          printList(list, now, io.out);
          const how = await choose('revoke:', ['one token', 'all tokens of a user'] as const);
          const r = how === 'one token' ? revokeToken(list, await ask('token id:')) : revokeUser(list, await pickUser(list));
          save(path, r.list);
          io.out(`revoked ${r.count} token(s)`);
        } else if (what === 'change user access') {
          const id = await pickUser(list);
          printAccess(io.out);
          save(path, setUser(list, id, { role: await choose('role:', ROLES), envs: await pickEnvs() }));
        } else if (what === 'prune expired') {
          const r = prune(list, {}, now);
          save(path, r.list);
          io.out(`removed ${r.tokens} token(s)`);
        }
        io.out(RELOAD_NOTE);
      } catch (e) {
        if (!(e instanceof InputError)) throw e;
        io.err(e.message);
      }
    }
  } finally {
    rl.close();
  }
}

/** Returns the exit code: 0 ok, 1 bad input, 2 the existing file is not a valid token list. */
export async function main(argv: string[], io: Io): Promise<number> {
  const now = (io.now ?? Date.now)();
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        file: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' },
        env: { type: 'string', multiple: true }, user: { type: 'string' }, days: { type: 'string' }, token: { type: 'string' },
        'older-than-days': { type: 'string' }, users: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) { io.out(USAGE); return 0; }
    if (positionals.length > 1) throw new InputError(USAGE);
    const path = resolve(values.file ?? 'token-list.json');
    if (positionals[0] === undefined) await wizard(path, io, now);
    else runCommand(positionals[0], values, path, io, now);
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err(`${e.message} — fix the file first; nothing was changed`);
      return 2;
    }
    if (e instanceof InputError) { io.err(e.message); return 1; }
    if (e instanceof InputClosed) { io.err('input closed; nothing more was changed'); return 1; }
    if (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS')) { io.err(`${e.message}\n${USAGE}`); return 1; }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main(process.argv.slice(2), { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) });
}

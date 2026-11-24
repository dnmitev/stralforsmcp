// `npm run token` — manage the token list without hand-editing JSON.
//   npm run token                       interactive wizard
//   npm run token -- <command> [flags]  scriptable (see USAGE)
// Every write is checked with the server's own parser first; an invalid existing file is refused, never changed.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs, styleText } from 'node:util';
import { ENVS, parseTokenList, ROLES, type TokenList } from '../src/auth/index.ts';
import {
  accessTable, addUser, emptyList, InputError, type Issued, issueToken, listView, parseDays, parseEnvs, parseRole, prune, revokeToken, revokeUser, setUser,
} from '../src/admin/token-list.ts';
import { ConfigError } from '../src/stralfors/errors.ts';

export const USAGE = `usage: npm run token -- [command] [--file token-list.json] [flags]
  (no command)                                   interactive wizard
  add-user  --name NAME --role ${ROLES.join('|')} --env ${ENVS.join('|')} [--env ...] [--id ID]   (id generated when omitted)
  set-user  --id ID [--name NAME] [--role ROLE] [--env ENV ...]
  issue     --user ID [--days 1-90, default 30]
  list
  show      [--base64]                           the file as JSON (or base64 for a Secret's data field), plain text for copy-paste
  revoke    --token TOKEN_ID | --user ID
  prune     [--older-than-days N] [--users]
  access                                         what each role may call per environment`;

class InputClosed extends Error {}

const RELOAD_NOTE = () => `${ok('saved.')} The server re-reads the list within about 60 s; a revocation can take about 2 minutes (restart the pods to apply it at once).`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  input?: NodeJS.ReadableStream;
  now?: () => number;
  gen?: () => string;
  /** random part of generated user ids (tests) */
  rand?: () => string;
}

/** Exactly the text `save` writes: what goes into the Secret's token-list.json key. */
const fileText = (list: TokenList): string => `${JSON.stringify(parseTokenList(JSON.stringify(list)), null, 2)}\n`;

function show(list: TokenList, base64: boolean, io: Io): void {
  const text = fileText(list);
  io.out(base64 ? Buffer.from(text).toString('base64') : text.trimEnd());
}

// Text of each file as last read or written (null: did not exist). `save` refuses when the file changed since,
// so a slow wizard session never overwrites someone else's change (for example a revocation).
const seen = new Map<string, string | null>();
const current = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);

function load(path: string): TokenList {
  const text = current(path);
  seen.set(path, text);
  return text === null ? emptyList() : parseTokenList(text);
}

/** New 0600 file beside the target, renamed over it: never a half-written list, never a looser inherited mode. */
function save(path: string, list: TokenList): void {
  // ponytail: compare-then-rename leaves a millisecond window; a lock file is the upgrade if several operators share one file
  if (current(path) !== seen.get(path)) throw new InputError('the token list changed on disk since it was read; nothing was saved, run it again');
  const text = fileText(list);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
  seen.set(path, text);
}

const pad = (s: string, n: number) => s.padEnd(n);

// Colours only when the stream is a terminal and NO_COLOR / NODE_DISABLE_COLORS are unset (styleText checks both).
type Style = Parameters<typeof styleText>[0];
const paint = (stream: NodeJS.WriteStream) => (f: Style, s: string) => styleText(f, s, { stream });
const o = paint(process.stdout);
const ep = paint(process.stderr);
const bad = (s: string) => ep('red', s);
const ok = (s: string) => o('green', s);
const bold = (s: string) => o('bold', s);
const STATE: Record<string, Style> = { active: 'green', expired: 'gray', revoked: 'red' };
const cell = (s: string, n: number) => o(s === 'yes' ? 'green' : s.startsWith('only') ? 'yellow' : 'red', pad(s, n));

function printList(list: TokenList, now: number, out: Io['out']): void {
  const v = listView(list, now);
  out(bold('users:'));
  if (!v.users.length) out('  (none)');
  for (const u of v.users) out(`  ${o('cyan', pad(u.id, 16))} ${pad(u.role, 4)} ${pad(u.envs.join(','), 10)} active tokens: ${u.active}  ${u.name}`);
  out(bold('tokens:'));
  if (!v.tokens.length) out('  (none)');
  for (const t of v.tokens) out(`  ${o('cyan', t.id)}  ${pad(t.userId, 16)} ${o(STATE[t.state]!, pad(t.state, 8))} expires ${t.expires}`);
}

function printAccess(out: Io['out']): void {
  out(bold('access per role and environment (the user also needs that environment in --env):'));
  out(`  ${pad('role', 5)}${pad('env', 6)}${pad('read', 11)}${pad('validate', 49)}${pad('write', 40)}lookup`);
  for (const role of ROLES) for (const env of ENVS) {
    const r = (a: string) => accessTable().find((x) => x.role === role && x.env === env && x.access === a)!.result;
    out(`  ${pad(role, 5)}${pad(env, 6)}${cell(r('read'), 11)}${cell(r('validate'), 49)}${cell(r('write'), 40)}${cell(r('lookup'), 0)}`);
  }
  out('  read = whoami, list_channels, get_rules, get_example_invoice, track_document, search_docs; validate = validate_invoice;');
  out('  write = send_invoice (test only); lookup = channel_lookup (test only). Stralfors scopes of the profile apply on top.');
}

function issued(io: Io, r: Issued): void {
  io.out(`${ok('issued')} token ${o('cyan', r.id)} for user ${o('cyan', r.user.id)} (${bold(r.user.name)}), role ${bold(r.user.role)}, environments ${r.user.envs.join(', ')}, expires ${r.expires}`);
  io.err(`token (shown once, give it to the user over a private channel): ${ep(['bold', 'yellow'], r.raw)}`);
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
    case 'show':
      show(list, f['base64'] === true, io);
      return;
    case 'add-user': {
      const r = addUser(list, { id: s('id'), name: need(s('name'), '--name'), role: parseRole(need(s('role'), '--role')), envs: parseEnvs(envs ?? []) }, io.rand);
      list = r.list;
      io.out(`${ok('added')} user ${o('cyan', r.id)}`);
      break;
    }
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
      io.out(RELOAD_NOTE());
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
  io.out(RELOAD_NOTE());
}

async function wizard(path: string, io: Io, clock: () => number): Promise<void> {
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
      io.out(`${bold(q)}\n${opts.map((x, i) => `  ${o('cyan', String(i + 1))}) ${x}`).join('\n')}`);
      const a = await ask('>');
      const i = Number(a) - 1;
      if (Number.isInteger(i) && opts[i] !== undefined) return opts[i]!;
      if ((opts as readonly string[]).includes(a)) return a as T;
      io.err(bad(`choose 1-${opts.length}`));
    }
  };
  const retry = async <T>(f: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await f();
      } catch (e) {
        if (!(e instanceof InputError)) throw e;
        io.err(bad(e.message));
      }
    }
  };
  const pickEnvs = () => retry(async () => parseEnvs((await ask(`environments (${ENVS.join(', ')}; comma-separated) [test]:`) || 'test').split(',').map((x) => x.trim()).filter(Boolean)));
  const pickUser = async (list: TokenList) => {
    if (!list.users.length) throw new InputError('no users yet: add one first');
    const labels = list.users.map((u) => `${u.id}  ${u.name} (${u.role}; ${u.envs.join(', ')})`);
    return list.users[labels.indexOf(await choose('user:', labels))]!.id;
  };
  try {
    for (;;) {
      let list = load(path);
      const what = await choose(`token list ${path}`, ['add user and issue token', 'issue token', 'list', 'revoke', 'change user access', 'prune expired', 'show access', 'show token-list.json', 'quit'] as const);
      try {
        if (what === 'quit') return;
        if (what === 'list') { printList(list, clock(), io.out); continue; }
        if (what === 'show access') { printAccess(io.out); continue; }
        if (what === 'show token-list.json') { show(list, false, io); continue; }
        if (what === 'add user and issue token') {
          const name = await retry(async () => { const v = await ask('full name:'); if (!v) throw new InputError('--name must not be empty'); return v; });
          printAccess(io.out);
          const role = await choose('role:', ROLES);
          const added = addUser(list, { name, role, envs: await pickEnvs() }, io.rand);
          const days = await retry(async () => parseDays((await ask('days valid (1-90) [30]:')) || undefined));
          const r = issueToken(added.list, added.id, days, clock(), io.gen);
          save(path, r.list);
          issued(io, r);
        } else if (what === 'issue token') {
          const id = await pickUser(list);
          const days = await retry(async () => parseDays((await ask('days valid (1-90) [30]:')) || undefined));
          const r = issueToken(list, id, days, clock(), io.gen);
          save(path, r.list);
          issued(io, r);
        } else if (what === 'revoke') {
          printList(list, clock(), io.out);
          const how = await choose('revoke:', ['one token', 'all tokens of a user'] as const);
          const r = how === 'one token' ? revokeToken(list, await ask('token id:')) : revokeUser(list, await pickUser(list));
          save(path, r.list);
          io.out(`revoked ${r.count} token(s)`);
        } else if (what === 'change user access') {
          const id = await pickUser(list);
          printAccess(io.out);
          save(path, setUser(list, id, { role: await choose('role:', ROLES), envs: await pickEnvs() }));
        } else if (what === 'prune expired') {
          const r = prune(list, {}, clock());
          save(path, r.list);
          io.out(`removed ${r.tokens} token(s)`);
        }
        io.out(RELOAD_NOTE());
      } catch (e) {
        if (!(e instanceof InputError)) throw e;
        io.err(bad(e.message));
      }
    }
  } finally {
    rl.close();
  }
}

/** Returns the exit code: 0 ok, 1 bad input, 2 the existing file is not a valid token list. */
export async function main(argv: string[], io: Io): Promise<number> {
  const clock = io.now ?? Date.now;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        file: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' },
        env: { type: 'string', multiple: true }, user: { type: 'string' }, days: { type: 'string' }, token: { type: 'string' },
        'older-than-days': { type: 'string' }, users: { type: 'boolean' }, base64: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) { io.out(USAGE); return 0; }
    if (positionals.length > 1) throw new InputError(USAGE);
    const path = resolve(values.file ?? 'token-list.json');
    if (positionals[0] === undefined) await wizard(path, io, clock);
    else runCommand(positionals[0], values, path, io, clock());
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err(bad(`${e.message} — fix the file first; nothing was changed`));
      return 2;
    }
    if (e instanceof InputError) { io.err(bad(e.message)); return 1; }
    if (e instanceof InputClosed) { io.err(bad('input closed; nothing more was changed')); return 1; }
    if (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS')) { io.err(`${e.message}\n${USAGE}`); return 1; }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main(process.argv.slice(2), { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) });
}

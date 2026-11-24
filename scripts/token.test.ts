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
    rand: () => 'c0ffee00',
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
    expect(await t.run('add-user', '--role', 'dev', '--env', 'test')).toBe(1);
    expect(t.err.join('\n')).toContain('--name is required');
    expect(await t.run('add-user', '--id', 'a', '--name', 'A', '--role', 'dev', '--env', 'test')).toBe(0);
    expect(await t.run('add-user', '--id', 'a', '--name', 'A2', '--role', 'dev', '--env', 'test')).toBe(1);
    expect(t.err.join('\n')).toContain('user a already exists');
    expect(await t.run('add-user', '--name', 'Gen', '--role', 'pm', '--env', 'test')).toBe(0);
    expect(t.out.join('\n')).toContain('added user u_c0ffee00');
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
    expect(t.out.join('\n')).toMatch(/issued token [0-9a-f]{8} for user alice \(Alice\), role qa, environments test, prod, expires /);
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

  it('show prints the exact file (JSON or base64), plain, without raw tokens', async () => {
    const t = setup();
    await t.run('add-user', '--name', 'A', '--role', 'dev', '--env', 'test');
    await t.run('issue', '--user', 'u_c0ffee00');
    const file = readFileSync(t.file, 'utf8');
    t.out.length = 0;
    expect(await t.run('show')).toBe(0);
    expect(t.out).toEqual([file.trimEnd()]);
    t.out.length = 0;
    expect(await t.run('show', '--base64')).toBe(0);
    expect(Buffer.from(t.out[0]!, 'base64').toString()).toBe(file);
    expect(t.out.join('\n')).not.toContain('smcp_');
    expect(t.out.join('\n')).not.toContain(String.fromCharCode(27)); // no colour codes in copy-paste output
    const empty = setup();
    expect(await empty.run('show')).toBe(0);
    expect(JSON.parse(empty.out[0]!)).toEqual({ users: [], tokens: [] });
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
    const t = setup(['1', 'Bob Builder', 'SA', '9', '2', 'stage', 'test', '91', '14', '8', '9']);
    expect(await main(['--file', t.file], t.io)).toBe(0);
    const list = parseTokenList(readFileSync(t.file, 'utf8'));
    expect(list.users).toEqual([{ id: 'u_c0ffee00', name: 'Bob Builder', role: 'qa', envs: ['test'] }]);
    expect(t.out.join('\n')).toMatch(/issued token [0-9a-f]{8} for user u_c0ffee00 \(Bob Builder\), role qa, environments test, expires 2030-01-24T00:00:00.000Z/);
    expect(Date.parse(list.tokens[0]!.expires) - NOW).toBe(14 * 86_400_000);
    const e = t.err.join('\n');
    expect(e).toContain('choose 1-3');
    expect(e).toContain('--env must be one or more of: test, prod');
    expect(e).toContain('--days must be a whole number from 1 to 90');
    expect(e.match(/smcp_/g)).toHaveLength(1);
    expect(t.out.join('\n')).toContain(readFileSync(t.file, 'utf8').trimEnd()); // menu item 8 printed the file
  });

  it('refuses to overwrite a change made by someone else while it waited, then reloads', async () => {
    const t = setup(['1', 'Bob', '1', 'test', '30', '3', '9']);
    const other = JSON.stringify({ users: [{ id: 'x', name: 'X', role: 'pm', envs: ['test'] }], tokens: [] });
    // gen runs between the read and the save: simulate another operator writing the file at that moment
    t.io.gen = () => { writeFileSync(t.file, other); return gen(); };
    expect(await main(['--file', t.file], t.io)).toBe(0);
    expect(readFileSync(t.file, 'utf8')).toBe(other);
    expect(t.err.join('\n')).toContain('the token list changed on disk since it was read; nothing was saved');
    expect(t.out.join('\n')).toContain('pm'); // the next menu round listed the fresh file
  });

  it('reads the clock for each operation, not once at start', async () => {
    const t = setup(['3', '1', 'Bob', '1', 'test', '30', '9']);
    let calls = 0;
    t.io.now = () => NOW + calls++ * 86_400_000;
    expect(await main(['--file', t.file], t.io)).toBe(0);
    expect(parseTokenList(readFileSync(t.file, 'utf8')).tokens[0]!.created).toBe(new Date(NOW + 86_400_000).toISOString());
  });

  it('stops cleanly when input ends and never writes a partial user', async () => {
    const t = setup(['1', 'carol']);
    expect(await main(['--file', t.file], t.io)).toBe(1);
    expect(existsSync(t.file)).toBe(false);
  });

  it('refuses to start on an invalid existing file', async () => {
    const t = setup(['9']);
    writeFileSync(t.file, '{"users":[],"tokens":[],"x":1}');
    expect(await main(['--file', t.file], t.io)).toBe(2);
    expect(t.err.join('\n')).toContain('token list: (root) has unknown key');
  });
});

describe('npm run token (--kube-*)', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const LAST = 'kubectl.kubernetes.io/last-applied-configuration';

  /** In-memory Secret with resourceVersion; records every kubectl call. */
  function fakeKube(initial: string | null, extra: { labels?: Record<string, string>; annotations?: Record<string, string>; ownerReferences?: unknown[] } = {}) {
    let text = initial;
    let rv = 1;
    const calls: { args: string[]; stdin?: string }[] = [];
    const secret = () => JSON.stringify({
      kind: 'Secret', type: 'Opaque',
      metadata: { name: 'tl', namespace: 'ns', resourceVersion: String(rv), labels: { app: 'x', ...extra.labels }, annotations: { [LAST]: '{"data":"copy"}', keep: 'y', ...extra.annotations }, ...(extra.ownerReferences && { ownerReferences: extra.ownerReferences }) },
      data: { 'token-list.json': b64(text!) },
    });
    const kube = (args: string[], stdin?: string) => {
      calls.push({ args, stdin });
      if (args[0] === 'config') return { code: 0, stdout: 'ctx-a\n', stderr: '' };
      const verb = args.find((a) => ['get', 'replace', 'create'].includes(a));
      if (verb === 'get') return text === null ? { code: 1, stdout: '', stderr: 'Error from server (NotFound): secrets "tl" not found' } : { code: 0, stdout: secret(), stderr: '' };
      const m = JSON.parse(stdin!);
      if (verb === 'replace' && m.metadata.resourceVersion !== String(rv)) return { code: 1, stdout: '', stderr: 'Error from server (Conflict): the object has been modified' };
      text = Buffer.from(m.data['token-list.json'], 'base64').toString();
      rv++;
      return { code: 0, stdout: secret(), stderr: '' };
    };
    return { kube, calls, text: () => text, bump: (t: string) => { text = t; rv++; } };
  }
  const K = ['--kube-namespace', 'ns', '--kube-secret', 'tl'];

  it('never runs kubectl without --kube-* and checks flag combinations', async () => {
    const t = setup();
    const kube = () => { throw new Error('kubectl must not run'); };
    expect(await main(['list', '--file', t.file], { ...t.io, kube })).toBe(0);
    expect(await main(['list', '--kube-namespace', 'ns'], { ...t.io, kube })).toBe(1);
    expect(await main(['list', ...K, '--file', t.file], { ...t.io, kube })).toBe(1);
    expect(t.err.join('\n')).toContain('--kube-namespace and --kube-secret go together');
    expect(t.err.join('\n')).toContain('use either --file or --kube-*, not both');
  });

  it('reads, edits and replaces the Secret: manifest on stdin only, resourceVersion kept, last-applied dropped', async () => {
    const t = setup();
    const k = fakeKube('{"users":[],"tokens":[]}');
    expect(await main(['add-user', '--name', 'A', '--role', 'dev', '--env', 'test', ...K, '--kube-context', 'c1'], { ...t.io, kube: k.kube })).toBe(0);
    expect(k.calls.map((c) => c.args)).toEqual([
      ['--context', 'c1', 'get', 'secret', 'tl', '-n', 'ns', '-o', 'json'],
      ['--context', 'c1', 'replace', '-f', '-', '-o', 'json'],
    ]);
    const m = JSON.parse(k.calls[1]!.stdin!);
    expect(m.metadata).toEqual({ name: 'tl', namespace: 'ns', resourceVersion: '1', labels: { app: 'x' }, annotations: { keep: 'y' } });
    expect(parseTokenList(k.text()!).users[0]).toMatchObject({ id: 'u_c0ffee00', role: 'dev' });
    expect(t.err.join('\n')).toContain('target: Secret ns/tl key token-list.json (context c1)');
    expect(t.out.join('\n')).toContain('restart the server\'s deployment in namespace ns');
    expect(k.calls.flatMap((c) => c.args).join(' ')).not.toContain('users');
  });

  // AEGIS F-10-104: a Secret another tool reconciles would silently undo an issue or a revocation on its next sync
  it.each([
    ['an owner (ExternalSecret)', { ownerReferences: [{ apiVersion: 'external-secrets.io/v1', kind: 'ExternalSecret', name: 'tl', uid: 'u' }] }, 'ExternalSecret'],
    ['an Argo CD instance label', { labels: { 'argocd.argoproj.io/instance': 'app' } }, 'argocd.argoproj.io/instance'],
    ['an Argo CD tracking annotation', { annotations: { 'argocd.argoproj.io/tracking-id': 'app:/Secret:ns/tl' } }, 'argocd.argoproj.io/tracking-id'],
    ['a managed-by label', { labels: { 'app.kubernetes.io/managed-by': 'Helm' } }, 'app.kubernetes.io/managed-by=Helm'],
    ['an external-secrets annotation', { annotations: { 'reconcile.external-secrets.io/data-hash': 'h' } }, 'reconcile.external-secrets.io/data-hash'],
    ['a Flux label', { labels: { 'kustomize.toolkit.fluxcd.io/name': 'apps' } }, 'kustomize.toolkit.fluxcd.io/name'],
  ])('refuses to write a Secret managed by another tool: %s', async (_n, extra, by) => {
    const t = setup();
    const k = fakeKube('{"users":[],"tokens":[]}', extra);
    expect(await main(['add-user', '--name', 'A', '--role', 'dev', '--env', 'test', ...K], { ...t.io, kube: k.kube })).toBe(1);
    expect(t.err.join('\n')).toContain(`managed by ${by}`);
    expect(t.err.join('\n')).toContain('--force-managed');
    expect(k.calls.some((c) => c.args.includes('replace') || c.args.includes('create'))).toBe(false);
    expect(parseTokenList(k.text()!).users).toEqual([]);
  });
  it('reads a managed Secret, and writes it only with --force-managed', async () => {
    const extra = { ownerReferences: [{ kind: 'ExternalSecret', name: 'tl' }] };
    const r = setup();
    expect(await main(['list', ...K], { ...r.io, kube: fakeKube('{"users":[],"tokens":[]}', extra).kube })).toBe(0);
    const t = setup();
    const k = fakeKube('{"users":[],"tokens":[]}', extra);
    expect(await main(['add-user', '--name', 'A', '--role', 'dev', '--env', 'test', ...K, '--force-managed'], { ...t.io, kube: k.kube })).toBe(0);
    expect(parseTokenList(k.text()!).users).toHaveLength(1);
    expect(JSON.parse(k.calls.find((c) => c.args.includes('replace'))!.stdin!).metadata.ownerReferences).toEqual(extra.ownerReferences);
  });

  it('refuses a conflict and writes nothing more', async () => {
    const t = setup(['1', 'Bob', '1', 'test', '30', '9']);
    const k = fakeKube('{"users":[],"tokens":[]}');
    // someone else writes between the wizard's get and its replace
    t.io.gen = () => { k.bump('{"users":[{"id":"x","name":"X","role":"pm","envs":["test"]}],"tokens":[]}'); return gen(); };
    expect(await main(K, { ...t.io, kube: k.kube })).toBe(0);
    expect(t.err.join('\n')).toContain('the Secret changed since it was read; nothing was saved, run it again');
    expect(parseTokenList(k.text()!).users.map((u) => u.id)).toEqual(['x']);
  });

  it('resolves the current context once and passes it to every call', async () => {
    const t = setup(['1', 'Ann', '1', 'test', '30', '9']);
    const k = fakeKube('{"users":[],"tokens":[]}');
    expect(await main(K, { ...t.io, kube: k.kube })).toBe(0);
    expect(k.calls.filter((c) => c.args[0] === 'config')).toHaveLength(1);
    expect(k.calls.filter((c) => c.args[0] !== 'config').every((c) => c.args[0] === '--context' && c.args[1] === 'ctx-a')).toBe(true);
    expect(t.err.join('\n')).toContain('target: Secret ns/tl key token-list.json (context ctx-a)');
    const none = setup();
    expect(await main(['list', ...K], { ...none.io, kube: () => ({ code: 1, stdout: '', stderr: 'error: current-context is not set' }) })).toBe(1);
    expect(none.err.join('\n')).toContain('no current kubectl context; pass --kube-context');
  });

  it('uses the new resourceVersion for the next save in one wizard session', async () => {
    const t = setup(['1', 'Ann', '1', 'test', '30', '1', 'Ben', '2', 'test', '30', '9']);
    const k = fakeKube('{"users":[],"tokens":[]}');
    let r = 0;
    t.io.rand = () => ['aaaaaaaa', 'bbbbbbbb'][r++]!;
    expect(await main(K, { ...t.io, kube: k.kube })).toBe(0);
    expect(parseTokenList(k.text()!).users.map((u) => u.name)).toEqual(['Ann', 'Ben']);
    expect(t.err.join('\n')).not.toContain('changed since');
  });

  it('creates a missing Secret on write; list on a missing Secret exits 1', async () => {
    const t = setup();
    const k = fakeKube(null);
    expect(await main(['list', ...K], { ...t.io, kube: k.kube })).toBe(1);
    expect(t.err.join('\n')).toContain('Secret ns/tl not found');
    expect(await main(['add-user', '--name', 'A', '--role', 'qa', '--env', 'test', ...K], { ...t.io, kube: k.kube })).toBe(0);
    const create = k.calls.find((c) => c.args.includes('create'))!;
    expect(JSON.parse(create.stdin!).metadata).toEqual({ name: 'tl', namespace: 'ns' });
  });

  it('an invalid list in the Secret exits 2; kubectl errors exit 1 with the first stderr line only', async () => {
    const t = setup();
    const k = fakeKube('{"users":[{"id":"1","name":"X","role":"SA","envs":["test"]}],"tokens":[]}');
    expect(await main(['list', ...K], { ...t.io, kube: k.kube })).toBe(2);
    expect(t.err.join('\n')).toContain('users[0].role is invalid');
    const failing = (args: string[]) => (args[0] === 'config' ? { code: 0, stdout: 'ctx-a', stderr: '' } : { code: 1, stdout: '', stderr: 'error: You must be logged in to the server (Unauthorized)\nsecond line' });
    expect(await main(['list', ...K], { ...t.io, kube: failing })).toBe(1);
    expect(t.err.join('\n')).toContain('kubectl get failed: error: You must be logged in to the server (Unauthorized)');
    expect(t.err.join('\n')).not.toContain('second line');
  });
});

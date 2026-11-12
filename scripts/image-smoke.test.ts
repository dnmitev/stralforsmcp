import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, redact, runArgs, smoke, UsageError, writeFixture } from './image-smoke.ts';

const SCRIPT = join(import.meta.dirname, 'image-smoke.ts');
const NOTICE =
  "responseMode: 'json' drops mid-call notifications. subscriptions/listen streams are always served over SSE regardless; other notifications emitted before a result are dropped.";
const BODY_401 = '{"error":"invalid_token"}';
const TABLE: Record<string, string> = {
  MCP_TOKEN_LIST_FILE: '/run/smoke/token-list.json',
  MCP_HOSTNAMES: 'localhost,127.0.0.1',
  MCP_DRAIN_MS: '1000',
  STRALFORS_ENV: 'test',
  STRALFORS_PROFILES: 'smoke',
  STRALFORS_PROFILE_SMOKE_COUNTRY: 'XX',
  STRALFORS_PROFILE_SMOKE_CLIENT_ID_FILE: '/run/smoke/client-id',
  STRALFORS_PROFILE_SMOKE_CLIENT_SECRET_FILE: '/run/smoke/client-secret',
  STRALFORS_PROFILE_SMOKE_CERT_FILE: '/run/smoke/client.pem',
  STRALFORS_PROFILE_SMOKE_KEY_FILE: '/run/smoke/client.key',
};
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe('parseArgs', () => {
  it('defaults', () => {
    expect(parseArgs(['img:tag'])).toEqual({ image: 'img:tag', timeoutMs: 30000, stopTimeoutS: 15 });
  });
  it('--help', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });
  it('both flags', () => {
    expect(parseArgs(['img', '--timeout', '5000', '--stop-timeout', '3'])).toEqual({
      image: 'img',
      timeoutMs: 5000,
      stopTimeoutS: 3,
    });
  });
  it('accepts digest references', () => {
    const ref = `ghcr.io/o/r@sha256:${'a'.repeat(64)}`;
    expect(parseArgs([ref])).toMatchObject({ image: ref });
  });
  it.each([
    ['no args', []],
    ['two images', ['a', 'b']],
    ['shell metachar', ['img;rm -rf']],
    ['space', ['img x']],
    ['non-numeric timeout', ['img', '--timeout', 'x']],
    ['missing flag value', ['img', '--timeout']],
    ['unknown flag', ['img', '--privileged']],
  ])('throws UsageError: %s', (_n, argv) => {
    expect(() => parseArgs(argv as string[])).toThrow(UsageError);
  });
});

describe('CLI exit codes', () => {
  const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });
  it('--help: usage line, exit 0', () => {
    const r = run('--help');
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });
  it('no arguments: usage on stderr, exit 2', () => {
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/i);
  });
  it('invalid reference: exit 2', () => {
    expect(run('bad;ref').status).toBe(2);
  });
});

describe('runArgs', () => {
  const argv = runArgs('img', 'smcp-smoke-abcdef12', '/x/fixture', TABLE);
  it('fixed hardened prefix and image last', () => {
    expect(argv.slice(0, 17)).toEqual([
      'run', '-d', '--name', 'smcp-smoke-abcdef12', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--user', '65532:65532',
      '-p', '127.0.0.1:0:3000', '-p', '127.0.0.1:0:9464', '-v', '/x/fixture:/run/smoke:ro',
    ]);
    expect(argv.at(-1)).toBe('img');
  });
  it('-e pairs follow the table order, nothing else', () => {
    const pairs = argv.flatMap((a, i) => (argv[i - 1] === '-e' ? [a] : []));
    expect(pairs).toEqual(Object.entries(TABLE).map(([k, v]) => `${k}=${v}`));
    expect(argv.filter((a) => a === '-e')).toHaveLength(Object.keys(TABLE).length);
  });
  it('no privileged, no network flag, only loopback publishing, paths and names only', () => {
    expect(argv).not.toContain('--privileged');
    expect(argv.some((a) => a.startsWith('--network') || a === '--net')).toBe(false);
    expect(argv.filter((a, i) => argv[i - 1] === '-p').every((p) => p.startsWith('127.0.0.1:'))).toBe(true);
    for (const [i, a] of argv.entries()) {
      if (argv[i - 1] === '-e') expect(a.slice(a.indexOf('=') + 1)).toMatch(/^[\w.,/:-]+$/);
    }
  });
});

describe.skipIf(!hasOpenssl)('writeFixture', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smcp-test-fixture-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes exactly the six files, modes 0644 / dir 0755, env table', () => {
    const { env } = writeFixture(dir);
    expect(env).toEqual(TABLE);
    expect(readdirSync(dir).sort()).toEqual(
      ['ca.pem', 'client-id', 'client-secret', 'client.key', 'client.pem', 'token-list.json'],
    );
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o644);
  });
  it('content is synthetic and well formed', () => {
    writeFixture(dir);
    expect(JSON.parse(readFileSync(join(dir, 'token-list.json'), 'utf8'))).toEqual({
      users: [{ id: 'smoke', name: 'smoke', role: 'dev', envs: ['test'] }],
      tokens: [],
    });
    expect(readFileSync(join(dir, 'client-id'), 'utf8')).toContain('smoke-client');
    expect(readFileSync(join(dir, 'client-secret'), 'utf8').trim()).toMatch(/^[0-9a-f]{48}$/);
    expect(readFileSync(join(dir, 'client.key'), 'utf8').startsWith(['-----BEGIN', 'PRIVATE KEY-----'].join(' '))).toBe(true);
    expect(() =>
      execFileSync('openssl', ['verify', '-CAfile', join(dir, 'ca.pem'), join(dir, 'client.pem')], { stdio: 'pipe' }),
    ).not.toThrow();
  });
  it('secrets differ per call', () => {
    writeFixture(dir);
    const a = readFileSync(join(dir, 'client-secret'), 'utf8');
    writeFixture(dir);
    expect(readFileSync(join(dir, 'client-secret'), 'utf8')).not.toBe(a);
  });
});

describe('redact', () => {
  it('masks smcp_ tokens', () => {
    const t = 'A'.repeat(43);
    const out = redact(`x smcp_${t} y`);
    expect(out).not.toContain(t);
    expect(out).toBe('x smcp_*** y');
  });
  it('masks PEM blocks', () => {
    const pem = ['-----BEGIN ', 'PRIVATE KEY-----\nQUJDREVGRw==\n-----END ', 'PRIVATE KEY-----'].join(''); // assembled so the source holds no literal PEM block (leak scanners)
    expect(redact(`a ${pem} b`)).toBe('a [pem] b');
  });
  it('leaves ordinary text', () => {
    expect(redact('container started')).toBe('container started');
  });
});

// ---- smoke() with a fake runner and fake fetch ------------------------------------------------

type Res = { code: number; stdout: string; stderr: string };
const ok = (stdout = ''): Res => ({ code: 0, stdout, stderr: '' });

interface Rig {
  calls: string[][];
  out: string;
  err: string;
  fixtureDirs: string[];
  fetched: string[];
  run(over?: Partial<Opts>): Promise<number>;
}
interface Opts {
  runner: (a: string[], rig: Rig) => Res | Promise<Res> | undefined;
  fetch: (url: string, init?: RequestInit) => Response | Promise<Response>;
  timeoutMs: number;
}

const goodFetch = (url: string): Response => {
  if (url.endsWith('/healthz')) return new Response('ok', { status: 200 });
  if (url.endsWith('/metrics'))
    return new Response('# TYPE x gauge\nmcp_token_list_stale_seconds 0\n', {
      status: 200,
      headers: { 'content-type': 'text/plain; version=0.0.4' },
    });
  return new Response(BODY_401, { status: 401, headers: { 'www-authenticate': 'Bearer', 'content-type': 'application/json' } });
};

function rig(): Rig {
  const r: Rig = {
    calls: [],
    out: '',
    err: '',
    fixtureDirs: [],
    fetched: [],
    async run(over = {}) {
      return smoke(
        { image: 'img:t', timeoutMs: over.timeoutMs ?? 5000, stopTimeoutS: 15 },
        {
          tmpdir: () => tmpdir(),
          sleep: async () => {},
          stdout: { write: (s) => void (r.out += s) },
          stderr: { write: (s) => void (r.err += s) },
          fetch: (async (u: string | URL | Request, i?: RequestInit) => {
            r.fetched.push(String(u));
            return (over.fetch ?? goodFetch)(String(u), i);
          }) as typeof fetch,
          runner: {
            async exec(a) {
              r.calls.push(a);
              if (a[1] === '-d') {
                const v = a[a.indexOf('-v') + 1] ?? '';
                r.fixtureDirs.push(v.slice(0, v.indexOf(':/run/smoke')));
              }
              const custom = await over.runner?.(a, r);
              if (custom) return custom;
              if (a[0] === 'run' && a.includes('--rm')) return ok('v26.13.1\n');
              if (a[0] === 'run') return ok('cid123\n');
              if (a[0] === 'port') return ok(a[2] === '3000/tcp' ? '127.0.0.1:41234\n' : '127.0.0.1:41235\n');
              if (a[0] === 'logs') return ok(`${NOTICE}\n`);
              if (a[0] === 'inspect') return ok('0\n');
              return ok();
            },
          },
        },
      );
    },
  };
  return r;
}

const verb = (r: Rig, v: string) => r.calls.findIndex((c) => c[0] === v || (c[0] === 'rm' && v === 'rm'));

describe('smoke: happy path', () => {
  it('seven ok lines, PASS, exit 0, stop before rm -f, fixture removed', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    expect(await r.run()).toBe(0);
    expect(r.out.trim().split('\n')).toEqual([
      'ok: node v26.13.1',
      'ok: run',
      'ok: healthz',
      'ok: metrics',
      'ok: mcp 401',
      'ok: logs clean',
      'ok: sigterm exit 0',
      'PASS img:t',
    ]);
    expect(r.err).toBe('');
    const stop = r.calls.find((c) => c[0] === 'stop');
    expect(stop?.slice(0, 3)).toEqual(['stop', '-t', '15']);
    expect(verb(r, 'stop')).toBeLessThan(verb(r, 'rm'));
    const rm = r.calls.find((c) => c[0] === 'rm');
    expect(rm?.slice(0, 2)).toEqual(['rm', '-f']);
    const name = (r.calls.find((c) => c[1] === '-d') ?? [])[3] ?? '';
    expect(name).toMatch(/^smcp-smoke-[0-9a-f]{8}$/);
    expect(rm).toContain(name);
    expect(r.fixtureDirs).toHaveLength(1);
    expect(existsSync(r.fixtureDirs[0] ?? '')).toBe(false);
  });

  it('probes the mapped host ports on loopback; /mcp is POSTed without Authorization', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    const inits: RequestInit[] = [];
    await r.run({
      fetch: (u, i) => {
        if (i) inits.push(i);
        return goodFetch(u);
      },
    });
    expect(r.fetched).toContain('http://127.0.0.1:41234/healthz');
    expect(r.fetched).toContain('http://127.0.0.1:41235/metrics');
    expect(r.fetched).toContain('http://127.0.0.1:41234/mcp');
    const post = inits.find((i) => i.method === 'POST');
    expect(post?.body).toBe('{}');
    expect(JSON.stringify(post?.headers ?? {}).toLowerCase()).not.toContain('authorization');
  });
});

describe('smoke: failure modes (always clean up)', () => {
  const cleaned = (r: Rig) => {
    const rm = r.calls.find((c) => c[0] === 'rm');
    expect(rm?.slice(0, 2)).toEqual(['rm', '-f']);
    expect(r.fixtureDirs).toHaveLength(1);
    expect(existsSync(r.fixtureDirs[0] ?? '')).toBe(false);
  };

  it('healthz never ready -> timeout, later checks not attempted', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    const code = await r.run({ timeoutMs: 1, fetch: () => new Response('no', { status: 503 }) });
    expect(code).toBe(1);
    expect(r.err).toContain('FAIL: healthz: timeout');
    expect(r.out).toContain('FAIL img:t');
    expect(r.fetched.some((u) => u.endsWith('/metrics'))).toBe(false);
    expect(r.calls.some((c) => c[0] === 'stop')).toBe(false);
    cleaned(r);
  });

  it('healthz connection errors are retried until the bound', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    const code = await r.run({
      timeoutMs: 1,
      fetch: () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(code).toBe(1);
    expect(r.err).toContain('FAIL: healthz: timeout');
    cleaned(r);
  });

  it('metrics content-type / body', async () => {
    if (!hasOpenssl) return;
    for (const [res, reason] of [
      [new Response('# TYPE x gauge\nmcp_token_list_stale_seconds 0', { headers: { 'content-type': 'application/json' } }), 'content-type'],
      [new Response('# TYPE x gauge\n', { headers: { 'content-type': 'text/plain' } }), 'body'],
      [new Response('nope', { status: 500 }), 'status 500'],
    ] as const) {
      const r = rig();
      const code = await r.run({ fetch: (u) => (u.endsWith('/metrics') ? res.clone() : goodFetch(u)) });
      expect(code).toBe(1);
      expect(r.err).toContain(`FAIL: metrics: ${reason}`);
      cleaned(r);
    }
  });

  it('/mcp answering 200 -> status 200', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    const code = await r.run({ fetch: (u) => (u.endsWith('/mcp') ? new Response('{}', { status: 200 }) : goodFetch(u)) });
    expect(code).toBe(1);
    expect(r.err).toContain('FAIL: mcp 401: status 200');
    cleaned(r);
  });

  it('/mcp 401 with a different body -> body', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    const code = await r.run({
      fetch: (u) =>
        u.endsWith('/mcp')
          ? new Response('{"error":"other"}', { status: 401, headers: { 'www-authenticate': 'Bearer' } })
          : goodFetch(u),
    });
    expect(code).toBe(1);
    expect(r.err).toContain('FAIL: mcp 401: body');
    cleaned(r);
  });

  it.each([
    "(node:1) ExperimentalWarning: Type Stripping is an experimental feature",
    'error: something broke',
    'WARN something',
    'refusing to start: bad config',
  ])('log noise fails: %s', async (line) => {
    if (!hasOpenssl) return;
    const r = rig();
    const code = await r.run({ runner: (a) => (a[0] === 'logs' ? ok(`${NOTICE}\n${line}\n`) : undefined) });
    expect(code).toBe(1);
    expect(r.err).toContain('FAIL: logs clean: log line');
    cleaned(r);
  });

  it('only the SDK notice (on stderr of docker logs) passes', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    const code = await r.run({
      runner: (a) => (a[0] === 'logs' ? { code: 0, stdout: '', stderr: `${NOTICE}\n` } : undefined),
    });
    expect(code).toBe(0);
  });

  it('non-zero SIGTERM exit code', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    const code = await r.run({ runner: (a) => (a[0] === 'inspect' ? ok('137\n') : undefined) });
    expect(code).toBe(1);
    expect(r.err).toContain('FAIL: sigterm exit 0: exit code 137');
    cleaned(r);
  });

  it('docker run failing (code 125)', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    const code = await r.run({ runner: (a) => (a[1] === '-d' ? { code: 125, stdout: '', stderr: 'boom' } : undefined) });
    expect(code).toBe(1);
    expect(r.err).toContain('FAIL: run: docker 125');
    cleaned(r);
  });

  it('runner rejecting on run -d', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    const code = await r.run({
      runner: (a) => (a[1] === '-d' ? Promise.reject(new Error('spawn docker ENOENT')) : undefined),
    });
    expect(code).toBe(1);
    cleaned(r);
  });

  it('an error thrown inside a check still cleans up', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    const code = await r.run({
      fetch: (u) => {
        if (u.endsWith('/metrics')) throw new RangeError('boom');
        return goodFetch(u);
      },
    });
    expect(code).toBe(1);
    cleaned(r);
  });

  it('a failing docker rm -f is ignored', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    const code = await r.run({ runner: (a) => (a[0] === 'rm' ? { code: 1, stdout: '', stderr: 'gone' } : undefined) });
    expect(code).toBe(0);
  });
});

describe('smoke: output redaction', () => {
  it('never prints tokens, PEM bodies, the client secret, or more than 2000 chars of docker stderr', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    const token = `smcp_${'B'.repeat(43)}`;
    const pem = ['-----BEGIN ', 'PRIVATE KEY-----\nQUJDREVGRw==\n-----END ', 'PRIVATE KEY-----'].join(''); // assembled so the source holds no literal PEM block (leak scanners)
    let secret = '';
    const code = await r.run({
      runner: (a) => {
        if (a[1] !== '-d') return undefined;
        const v = a[a.indexOf('-v') + 1] ?? '';
        secret = readFileSync(join(v.slice(0, v.indexOf(':/run/smoke')), 'client-secret'), 'utf8').trim();
        return { code: 125, stdout: '', stderr: `${token} ${pem} ${secret} ${'x'.repeat(5000)}` };
      },
    });
    expect(code).toBe(1);
    const all = r.out + r.err;
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    expect(all).not.toContain('B'.repeat(43));
    expect(all).not.toContain('QUJDREVGRw');
    expect(all).not.toContain(secret);
    expect(all).toContain('***');
    expect(all).not.toContain('x'.repeat(2001));
  });

  it('docker stderr is not printed on success', async () => {
    if (!hasOpenssl) return;
    const r = rig();
    await r.run({ runner: (a) => (a[0] === 'stop' ? { code: 0, stdout: '', stderr: 'chatter-xyz' } : undefined) });
    expect(r.out + r.err).not.toContain('chatter-xyz');
  });
});

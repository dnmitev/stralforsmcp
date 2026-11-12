// Starts a built image under the hardening flags with a throwaway fixture and checks it from outside.
// Usage: node scripts/image-smoke.ts <image> [--timeout <ms>] [--stop-timeout <s>]
// Nothing here is a real credential: the PKI and the secret are generated per run and deleted in `finally`.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export interface Runner {
  exec(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}
export interface Deps {
  runner?: Runner;
  fetch?: typeof fetch;
  tmpdir?: () => string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
  sleep?: (ms: number) => Promise<void>;
}
export interface Options {
  image: string;
  timeoutMs: number;
  stopTimeoutS: number;
}

export class UsageError extends Error {}

const USAGE = 'usage: node scripts/image-smoke.ts <image> [--timeout <ms>] [--stop-timeout <s>]';
const NOTICE = "responseMode: 'json' drops mid-call notifications";
const UNAUTHORIZED_BODY = '{"error":"invalid_token"}';
const MOUNT = '/run/smoke';

export function parseArgs(argv: string[]): Options | { help: true } {
  if (argv.includes('--help')) return { help: true };
  let image: string | undefined;
  let timeoutMs = 30000;
  let stopTimeoutS = 15;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--timeout' || a === '--stop-timeout') {
      const v = argv[++i] ?? '';
      if (!/^\d+$/.test(v) || Number(v) < 1) throw new UsageError(`${a} needs a positive integer`);
      if (a === '--timeout') timeoutMs = Number(v);
      else stopTimeoutS = Number(v);
    } else if (a.startsWith('-') || image !== undefined || !/^[\w./:@-]+$/.test(a)) {
      throw new UsageError(`unexpected argument: ${a}`);
    } else image = a;
  }
  if (image === undefined) throw new UsageError('missing image');
  return { image, timeoutMs, stopTimeoutS };
}

const EC = ['-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256'];

/** Writes the synthetic PKI and config files into `dir` (must exist); returns the container env (paths and names only). */
export function writeFixture(dir: string): { env: Record<string, string> } {
  const scratch = join(dir, '.scratch');
  mkdirSync(scratch, { recursive: true });
  const ossl = (...a: string[]): void => void execFileSync('openssl', a, { cwd: scratch, stdio: 'pipe' });
  try {
    ossl('genpkey', ...EC, '-out', 'ca.key');
    ossl(
      'req', '-x509', '-new', '-key', 'ca.key', '-subj', '/CN=smoke-ca', '-days', '2',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign', '-out', 'ca.pem',
    );
    ossl('genpkey', ...EC, '-out', 'client.plain');
    ossl('req', '-new', '-key', 'client.plain', '-subj', '/CN=smoke', '-out', 'client.csr');
    ossl('pkcs8', '-topk8', '-nocrypt', '-in', 'client.plain', '-out', 'client.key');
    writeFileSync(join(scratch, 'client.ext'), 'basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n');
    ossl(
      'x509', '-req', '-in', 'client.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-days', '2', '-extfile', 'client.ext', '-out', 'client.pem',
    );
    for (const f of ['ca.pem', 'client.pem', 'client.key'])
      writeFileSync(join(dir, f), readFileSync(join(scratch, f)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(join(dir, 'client-id'), 'smoke-client\n');
  writeFileSync(join(dir, 'client-secret'), randomBytes(24).toString('hex'));
  writeFileSync(
    join(dir, 'token-list.json'),
    JSON.stringify({ users: [{ id: 'smoke', name: 'smoke', role: 'dev', envs: ['test'] }], tokens: [] }),
  );
  // uid 65532 must read a bind mount owned by the host user
  chmodSync(dir, 0o755);
  for (const f of ['ca.pem', 'client.pem', 'client.key', 'client-id', 'client-secret', 'token-list.json'])
    chmodSync(join(dir, f), 0o644);
  return {
    env: {
      MCP_TOKEN_LIST_FILE: `${MOUNT}/token-list.json`,
      MCP_HOSTNAMES: 'localhost,127.0.0.1',
      MCP_DRAIN_MS: '1000',
      STRALFORS_ENV: 'test',
      STRALFORS_PROFILES: 'smoke',
      STRALFORS_PROFILE_SMOKE_COUNTRY: 'XX',
      STRALFORS_PROFILE_SMOKE_CLIENT_ID_FILE: `${MOUNT}/client-id`,
      STRALFORS_PROFILE_SMOKE_CLIENT_SECRET_FILE: `${MOUNT}/client-secret`,
      STRALFORS_PROFILE_SMOKE_CERT_FILE: `${MOUNT}/client.pem`,
      STRALFORS_PROFILE_SMOKE_KEY_FILE: `${MOUNT}/client.key`,
    },
  };
}

export function runArgs(image: string, name: string, fixtureDir: string, env: Record<string, string>): string[] {
  return [
    'run', '-d', '--name', name, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', '65532:65532', '-p', '127.0.0.1:0:3000', '-p', '127.0.0.1:0:9464', '-v', `${fixtureDir}:${MOUNT}:ro`,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    image,
  ];
}

export function redact(s: string): string {
  return s
    .replace(/smcp_[A-Za-z0-9]{8,}/g, 'smcp_***')
    .replace(/-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g, '[pem]');
}

const execFileP = promisify(execFile);
const dockerRunner: Runner = {
  async exec(args) {
    try {
      const r = await execFileP('docker', args, { maxBuffer: 16 * 1024 * 1024 });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      const x = e as { code?: unknown; stdout?: string; stderr?: string };
      return { code: typeof x.code === 'number' ? x.code : 1, stdout: x.stdout ?? '', stderr: x.stderr ?? String(e) };
    }
  },
};

class Fail extends Error {
  detail: string;
  constructor(reason: string, detail = '') {
    super(reason);
    this.detail = detail;
  }
}

export async function smoke(opts: Options, deps: Deps = {}): Promise<number> {
  const runner = deps.runner ?? dockerRunner;
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const dir = mkdtempSync(join((deps.tmpdir ?? tmpdir)(), 'smcp-smoke-'));
  const name = `smcp-smoke-${randomBytes(4).toString('hex')}`;
  let secret = '';
  const scrub = (s: string): string => {
    const r = redact(s);
    return secret ? r.split(secret).join('***') : r;
  };
  const docker = async (args: string[], what: string): Promise<string> => {
    const r = await runner.exec(args);
    if (r.code !== 0) throw new Fail(`docker ${r.code}`, `${what}: ${r.stderr}`);
    return r.stdout;
  };
  const get = (url: string, init?: RequestInit): Promise<Response> =>
    doFetch(url, { ...init, signal: AbortSignal.timeout(5000) });

  let label = 'fixture';
  let port3000 = 0;
  let port9464 = 0;
  const hostPort = async (p: string): Promise<number> => {
    const m = /:(\d+)\s*$/m.exec(await docker(['port', name, p], 'port'));
    if (!m) throw new Fail('port');
    return Number(m[1]);
  };
  const step = async (l: string, fn: () => Promise<string>): Promise<void> => {
    label = l;
    stdout.write(`ok: ${scrub(await fn())}\n`);
  };

  try {
    const { env } = writeFixture(dir);
    secret = readFileSync(join(dir, 'client-secret'), 'utf8').trim();
    await step('node', async () => {
      const v = (await docker(['run', '--rm', opts.image, '--version'], 'version')).trim();
      if (!/^v(2[6-9]|[3-9]\d)\.\d+\.\d+$/.test(v)) throw new Fail('version');
      return `node ${v}`;
    });
    await step('run', async () => {
      await docker(runArgs(opts.image, name, dir, env), 'run');
      port3000 = await hostPort('3000/tcp');
      port9464 = await hostPort('9464/tcp');
      return 'run';
    });
    await step('healthz', async () => {
      const deadline = Date.now() + opts.timeoutMs;
      for (;;) {
        try {
          const r = await get(`http://127.0.0.1:${port3000}/healthz`);
          if (r.status === 200 && (await r.text()).trim() === 'ok') return 'healthz';
        } catch {
          // not listening yet
        }
        if (Date.now() >= deadline) throw new Fail('timeout');
        await sleep(250);
      }
    });
    await step('metrics', async () => {
      const r = await get(`http://127.0.0.1:${port9464}/metrics`);
      if (r.status !== 200) throw new Fail(`status ${r.status}`);
      if (!(r.headers.get('content-type') ?? '').startsWith('text/plain')) throw new Fail('content-type');
      const body = await r.text();
      if (!body.includes('# TYPE ') || !body.includes('mcp_token_list_stale_seconds')) throw new Fail('body');
      return 'metrics';
    });
    await step('mcp 401', async () => {
      const r = await get(`http://127.0.0.1:${port3000}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (r.status !== 401) throw new Fail(`status ${r.status}`);
      if (!r.headers.has('www-authenticate')) throw new Fail('header');
      if ((await r.text()) !== UNAUTHORIZED_BODY) throw new Fail('body');
      return 'mcp 401';
    });
    await step('logs clean', async () => {
      const r = await runner.exec(['logs', name]);
      if (r.code !== 0) throw new Fail(`docker ${r.code}`, r.stderr);
      const bad = `${r.stdout}\n${r.stderr}`
        .split('\n')
        .some((l) => /warn|error|refusing to start|ExperimentalWarning/i.test(l) && !l.includes(NOTICE));
      if (bad) throw new Fail('log line');
      return 'logs clean';
    });
    await step('sigterm exit 0', async () => {
      await docker(['stop', '-t', String(opts.stopTimeoutS), name], 'stop');
      const code = (await docker(['inspect', '--format', '{{.State.ExitCode}}', name], 'inspect')).trim();
      if (code !== '0') throw new Fail(`exit code ${code}`);
      return 'sigterm exit 0';
    });
    stdout.write(`PASS ${opts.image}\n`);
    return 0;
  } catch (e) {
    const f = e instanceof Fail ? e : new Fail('error');
    stderr.write(`FAIL: ${label}: ${f.message}\n`);
    if (f.detail) stderr.write(`${scrub(f.detail).slice(0, 2000)}\n`);
    stdout.write(`FAIL ${opts.image}\n`);
    return 1;
  } finally {
    try {
      await runner.exec(['rm', '-f', name]);
    } catch {
      // best effort
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if ('help' in args) process.stdout.write(`${USAGE}\n`);
    else process.exit(await smoke(args));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
}

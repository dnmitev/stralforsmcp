// Docker CLI helper for the integration tier. execFile only (never a shell); no package beyond node:*.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** `docker <args>`, resolves with trimmed stdout. Rejects with a short message (docker's stderr can echo flag values, so it is dropped). */
export async function docker(args: string[], timeoutMs = 60_000): Promise<string> {
  try {
    return (await run('docker', args, { timeout: timeoutMs, maxBuffer: 10_000_000 })).stdout.trim();
  } catch (e) {
    throw new Error(`docker ${args[0]} failed (${(e as { code?: unknown }).code ?? 'error'})`);
  }
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(['info', '--format', '{{.ServerVersion}}'], 10_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Skip rule. Docker present: true. Docker absent and CI unset: false (the caller skips, once, with a message).
 * Docker absent and CI set: throws, so a skipped job can never look green.
 */
export async function integrationEnabled(): Promise<boolean> {
  if (await dockerAvailable()) return true;
  if (process.env['CI']) throw new Error('integration suite: Docker is not available but CI is set');
  console.warn('integration suite skipped: Docker is not available (set CI to make this an error)');
  return false;
}

/** Polls `url` until it answers 2xx; no fixed sleeps beyond the poll interval. */
export async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${new URL(url).pathname}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const live = new Map<string, () => void>();
let hooked = false;

function removeAllSync(): void {
  for (const [name, cleanup] of live) {
    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 20_000 });
    } catch {}
    try {
      cleanup();
    } catch {}
  }
  live.clear();
}

/** Registers `name` for removal on exit, SIGINT and SIGTERM, then runs `cleanup` (generated files; must be idempotent). The afterAll path calls removeForce itself. */
export function track(name: string, cleanup: () => void = () => {}): void {
  live.set(name, cleanup);
  if (hooked) return;
  hooked = true;
  process.on('exit', removeAllSync);
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.on(sig, () => {
      removeAllSync();
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
}

export async function removeForce(name: string): Promise<void> {
  await docker(['rm', '-f', name], 30_000);
  live.delete(name);
}

/** Host address Docker published for a container port, e.g. `8080/tcp` -> 49153. */
export async function hostPort(name: string, containerPort: string): Promise<number> {
  const out = await docker(['port', name, containerPort]);
  const m = /127\.0\.0\.1:(\d+)/.exec(out);
  if (!m) throw new Error(`no loopback port published for ${containerPort}`);
  return Number(m[1]);
}

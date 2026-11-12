// Runs the built .mcpb bridge as a child process (real stdio wire). The bundle comes from scripts/build-mcpb.ts so tests and release share bundler settings.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export const LINES = {
  config: 'stralforsmcp-bridge: MCP_URL and MCP_TOKEN are required',
  url: 'stralforsmcp-bridge: MCP_URL must be https, or http on localhost',
  upstream: 'stralforsmcp-bridge: upstream error',
};

let built: Promise<{ dir: string; file: string; metafile: { inputs: Record<string, unknown>; outputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[] }> } }> | undefined;
/** Bundles the bridge once per test file. */
export function bundle() {
  built ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smcp-bridge-'));
    const { bundleBridge } = await import('../../scripts/build-mcpb.ts');
    return { dir, ...(await bundleBridge(dir)) } as Awaited<NonNullable<typeof built>>;
  })();
  return built;
}
export async function cleanupBundle() {
  if (!built) return;
  const b = await built.catch(() => undefined);
  if (b) rmSync(b.dir, { recursive: true, force: true });
  built = undefined;
}

export interface Run { code: number | null; stdout: string; stderr: string; frames: Record<string, unknown>[] }
const ENV_BASE = { PATH: process.env.PATH ?? '' };

/**
 * Spawns `node <bundle>` with exactly `env`, writes `input` (JSON-RPC messages) to stdin, waits for `expect` response frames
 * (or for the process to exit), then closes stdin and waits for exit.
 */
export async function runBridge(env: Record<string, string>, input: object[] = [], expect = 0): Promise<Run> {
  const { file } = await bundle();
  const child = spawn(process.execPath, [file], { env: { ...ENV_BASE, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const frames = () => stdout.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
  const responses = () => frames().filter((f) => 'result' in f || 'error' in f).length;
  const closeStdin = () => child.stdin.end();
  child.stdin.on('error', () => undefined); // EPIPE when the bridge already exited
  child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); if (responses() >= expect) closeStdin(); });
  child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
  for (const m of input) child.stdin.write(`${JSON.stringify(m)}\n`);
  if (expect === 0) closeStdin();
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { code, stdout, stderr, frames: frames() };
}

export const initialize = (id = 1) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-test', version: '1.0.0' } } });
export const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
export const listTools = (id = 2) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
export const callWhoami = (id = 3) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'whoami', arguments: {} } });

/** SDK client over StdioClientTransport spawning the bridge; stderr is captured. */
export async function connectBridge(env: Record<string, string>) {
  const { file } = await bundle();
  const transport = new StdioClientTransport({ command: process.execPath, args: [file], env: { ...ENV_BASE, ...env }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

/** Plain-http upstream that records requests and answers `initialize` with a canned result; every request is counted. */
export async function recordingUpstream() {
  const seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      let id: unknown;
      try { id = (JSON.parse(body) as { id?: unknown }).id; } catch { /* not JSON */ }
      if (id === undefined) { res.writeHead(202).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub', version: '0' } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { port, url: `http://127.0.0.1:${port}/mcp`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

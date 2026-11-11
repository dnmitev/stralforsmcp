// Synthetic fixtures for the MCP server tests. Tokens, digests and ids are generated at run time only.
import { request, type IncomingHttpHeaders } from 'node:http';
import * as z from 'zod/v4';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, type AuthInfo, type McpServerFactory } from '@modelcontextprotocol/server';
import { createAudit, type AuditEvent } from '../../src/audit/index.ts';
import { createTokenStore, generateToken, type Env, type Principal, type Role, type TokenList, type TokenStore } from '../../src/auth/index.ts';
import type { ToolDef } from '../../src/server/tools.ts';
import { DAY, T, entry, iso } from './token-list.ts';

export const sink = () => {
  const chunks: string[] = [];
  const audit = createAudit({ destination: { write: (s) => void chunks.push(s) }, now: () => T });
  return { audit, text: () => chunks.join(''), lines: () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEvent & Record<string, unknown>) };
};

export const principal = (role: Role, envs: Env[], name = 'Some Name'): Principal => ({ userId: `u-${role}-${envs.join('')}`, name, role, envs });

export const toAuth = (p: Principal, expiresAt = Math.floor((T + DAY) / 1000)): AuthInfo => ({ token: '', clientId: p.userId, scopes: [], expiresAt, extra: { principal: p } });

export interface World {
  store: TokenStore;
  tA: string; // dev [test, prod]
  tPm: string; // pm [test]
  tQa: string; // qa [test]
  tRevoked: string;
  tExpired: string;
  tFuture: string;
  unknown: string;
}
/** A store with one token per principal kind plus the failing causes. `now` is T. */
export function world(): World {
  const raw = { tA: generateToken(), tPm: generateToken(), tQa: generateToken(), tRevoked: generateToken(), tExpired: generateToken(), tFuture: generateToken() };
  const list: TokenList = {
    users: [
      { id: 'u1', name: 'User One', role: 'dev', envs: ['test', 'prod'] },
      { id: 'u2', name: 'User Two', role: 'pm', envs: ['test'] },
      { id: 'u3', name: 'User Three', role: 'qa', envs: ['test'] },
    ],
    tokens: [
      entry(raw.tA, 'u1'),
      entry(raw.tPm, 'u2'),
      entry(raw.tQa, 'u3'),
      entry(raw.tRevoked, 'u2', { revoked: true }),
      entry(raw.tExpired, 'u2', { expires: iso(T - 1000), created: iso(T - 2 * DAY) }),
      entry(raw.tFuture, 'u2', { created: iso(T + DAY), expires: iso(T + 30 * DAY) }),
    ],
  };
  const store = createTokenStore({ read: () => JSON.stringify(list), now: () => T, setTimer: () => 'h', clearTimer: () => undefined, log: { warn: () => undefined, info: () => undefined } });
  return { store, ...raw, unknown: generateToken() };
}

const empty = z.object({});
const out = z.object({ v: z.number() });
const ann = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const mkDef = (name: string, access: 'read' | 'validate' | 'write', run: ToolDef['run'] = async () => ({ v: 1 }), requiredScope?: string): ToolDef => ({
  spec: { name, access, ...(requiredScope === undefined ? {} : { requiredScope }) },
  title: `Title ${name}`,
  description: `Description ${name}`,
  inputSchema: empty,
  outputSchema: out,
  annotations: access === 'read' ? ann : { ...ann, readOnlyHint: false },
  run,
});
export const okTool = mkDef('okTool', 'read');
export const writeTool = mkDef('writeTool', 'write');
export const devOnly = mkDef('devOnly', 'read', async () => ({ v: 1 }), 'x');
export const boomTool = (message = 'UPSTREAM-CANARY ARG-CANARY') => mkDef('boomTool', 'read', async () => { throw new Error(message); });

export const ERAS = ['modern', 'legacy'] as const;
export type Era = (typeof ERAS)[number];

/** SDK client; `fetchImpl` decides where requests go. */
export async function connect(era: Era, fetchImpl: typeof fetch, url = 'http://mcp.example.test/mcp'): Promise<Client> {
  const c = new Client({ name: 'test-client', version: '1.0.0' }, era === 'modern' ? { versionNegotiation: { mode: 'auto' } } : {});
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: fetchImpl }));
  return c;
}

/** A fetch that sends the request into an in-process MCP handler with the given authInfo (no HTTP front). */
export function handlerFetch(factory: McpServerFactory, auth: AuthInfo | undefined) {
  const handler = createMcpHandler(factory, { responseMode: 'json', legacy: 'stateless' });
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => handler.fetch(new Request(url, init), auth === undefined ? undefined : { authInfo: auth })) as typeof fetch;
  return { handler, fetch: f };
}

export const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
export const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
export const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

export interface Raw { status: number; headers: IncomingHttpHeaders; text: string }
/** Raw node:http request so Host, Content-Length and Transfer-Encoding are fully controlled. `host: null` omits Host. */
export function send(port: number, o: { method?: string; path?: string; headers?: Record<string, string | null | undefined>; body?: string; hold?: boolean } = {}): Promise<Raw> {
  const headers: Record<string, string> = {};
  const h: Record<string, string | null | undefined> = { host: 'mcp.example.test', ...o.headers };
  for (const [k, v] of Object.entries(h)) if (v !== null && v !== undefined) headers[k] = v;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'POST', path: o.path ?? '/mcp', headers, setHost: false, agent: false }, (res) => {
      const bufs: Buffer[] = [];
      res.on('data', (b: Buffer) => bufs.push(b));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(bufs).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (o.hold) req.flushHeaders(); // declared body never sent
    else req.end(o.body);
  });
}

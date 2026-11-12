import { afterEach } from 'vitest';
import type { McpRequestContext, McpServerFactory } from '@modelcontextprotocol/server';
import { buildMcp } from '../../src/server/mcp.ts';
import { createHttpServer, type HttpServer, type HttpServerOptions } from '../../src/server/http.ts';
import { createRateLimiter } from '../../src/server/rate-limit.ts';
import { whoami } from '../../src/server/whoami.ts';
import type { ToolDef } from '../../src/server/tools.ts';
import { MCP_HEADERS, INIT, send, sink, okTool, world, type Raw, type World } from './server.ts';
import { T } from './token-list.ts';

const open: HttpServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

export interface Harness {
  w: World;
  s: ReturnType<typeof sink>;
  srv: HttpServer;
  port: number;
  calls: McpRequestContext[];
  errors: Error[];
  /** valid MCP request with the given token (default tA) and optional header overrides */
  post: (o?: { token?: string | null; headers?: Record<string, string | null | undefined>; body?: string; path?: string }) => Promise<Raw>;
  /** fetch that adds the bearer token and records every response's headers */
  fetchFor: (token: string, seen?: Headers[]) => typeof fetch;
}

export async function startHttp(over: Partial<HttpServerOptions> & { tools?: ToolDef[]; allowWrite?: boolean; world?: World } = {}): Promise<Harness> {
  const w = over.world ?? world();
  const s = sink();
  const calls: McpRequestContext[] = [];
  const errors: Error[] = [];
  const env = over.env ?? 'test';
  const inner = buildMcp({ env, allowWrite: over.allowWrite ?? false, prodValidateEnabled: false, audit: over.audit ?? s.audit, tools: over.tools ?? [whoami, okTool], now: () => T, ...(over.telemetry ? { telemetry: over.telemetry } : {}) });
  const factory: McpServerFactory = over.factory ?? ((ctx) => (calls.push(ctx), inner(ctx)));
  const { tools: _t, allowWrite: _a, world: _w, ...rest } = over;
  const srv = createHttpServer({
    store: w.store, audit: s.audit, env, hosts: ['mcp.example.test'], origins: ['app.example.test'], maxBodyBytes: 1024, drainMs: 100, factory, limiter: createRateLimiter({ perMinute: 60_000, burst: 10_000 }), now: () => T,
    onerror: (e) => void errors.push(e), ...rest,
  });
  open.push(srv);
  const { port } = await srv.listen(0);
  const post: Harness['post'] = (o = {}) => {
    const token = o.token === undefined ? w.tA : o.token;
    return send(port, { path: o.path, body: o.body ?? INIT, headers: { ...MCP_HEADERS, ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...o.headers } });
  };
  const fetchFor: Harness['fetchFor'] = (token, seen) => async (url, init) => {
    const u = new URL(String(url instanceof Request ? url.url : url));
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    const r = await fetch(`http://127.0.0.1:${port}${u.pathname}`, { ...init, headers });
    seen?.push(r.headers);
    return r;
  };
  return { w, s, srv, port, calls, errors, post, fetchFor };
}
export { open as _open };

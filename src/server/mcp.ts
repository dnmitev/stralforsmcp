import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import type { Audit } from '../audit/index.ts';
import type { Env, Principal } from '../auth/index.ts';
import { serverInfo as defaultInfo } from '../server-info.ts';
import type { ScopeHolder } from '../policy/index.ts';
import type { Telemetry } from '../telemetry/index.ts';
import { assertClaimsWired, registerAll, type ToolDef } from './tools.ts';

export interface McpDeps {
  env: Env;
  allowWrite: boolean;
  prodValidateEnabled: boolean;
  claims?: ScopeHolder;
  audit: Audit;
  tools: ToolDef[];
  serverInfo?: { name: string; version: string };
  now?: () => number;
  telemetry?: Telemetry;
}

/** The per-request factory: cheap, no I/O, a fresh McpServer per call, only the caller's visible tools. No principal, no tools (fail closed). */
export function buildMcp(deps: McpDeps): McpServerFactory {
  assertClaimsWired(deps.tools, deps.claims);
  return (ctx) => {
    const principal = ctx.authInfo?.extra?.principal as Principal | undefined;
    const server = new McpServer(deps.serverInfo ?? defaultInfo);
    if (principal) registerAll(server, principal, deps.tools, { env: deps.env, allowWrite: deps.allowWrite, prodValidateEnabled: deps.prodValidateEnabled, claims: deps.claims, audit: deps.audit, now: deps.now, telemetry: deps.telemetry });
    return server;
  };
}

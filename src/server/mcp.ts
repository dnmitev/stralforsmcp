import { McpServer, type AuthInfo, type McpServerFactory } from '@modelcontextprotocol/server';
import type { Audit } from '../audit/index.ts';
import type { Env, Principal } from '../auth/index.ts';
import { serverInfo as defaultInfo } from '../server-info.ts';
import { decide, type ScopeHolder, type ToolSpec } from '../policy/index.ts';
import type { Telemetry } from '../telemetry/index.ts';
import type { KnowledgeDoc } from '../knowledge/index.ts';
import { registerPrompts } from './prompts.ts';
import { registerKnowledgeResources } from './resources.ts';
import { assertClaimsWired, needsScope, registerAll, type ToolDef } from './tools.ts';

export interface McpDeps {
  env: Env;
  allowWrite: boolean;
  prodValidateEnabled: boolean;
  /** Where claims come from: called once per request with that caller's AuthInfo. No source, or no claims for a caller, hides every scoped and write tool (fail closed). */
  claimsFor?: (authInfo: AuthInfo | undefined) => ScopeHolder | undefined;
  audit: Audit;
  tools: ToolDef[];
  serverInfo?: { name: string; version: string };
  now?: () => number;
  telemetry?: Telemetry;
  maxOutputBytes?: number;
  /** Docs loaded once at start; with a principal they become resources. Prompts need no knowledge. */
  knowledge?: { docs: KnowledgeDoc[] };
}

/** Resources and prompts stand in for a read tool: they are offered only to a principal for whom a plain read tool passes the policy (env, role). */
const KNOWLEDGE_ACCESS: ToolSpec = { name: 'knowledge', access: 'read' };

/** The per-request factory: cheap, no I/O, a fresh McpServer per call, only the caller's visible tools. No principal, no tools (fail closed). */
export function buildMcp(deps: McpDeps): McpServerFactory {
  assertClaimsWired(deps.tools, deps.claimsFor);
  return (ctx) => {
    const principal = ctx.authInfo?.extra?.principal as Principal | undefined;
    const server = new McpServer(deps.serverInfo ?? defaultInfo);
    const claims = deps.claimsFor?.(ctx.authInfo);
    const tools = claims ? deps.tools : deps.tools.filter((t) => !needsScope(t.spec));
    if (principal) registerAll(server, principal, tools, { env: deps.env, allowWrite: deps.allowWrite, prodValidateEnabled: deps.prodValidateEnabled, claims, audit: deps.audit, now: deps.now, telemetry: deps.telemetry, maxOutputBytes: deps.maxOutputBytes });
    if (principal && decide({ principal, env: deps.env, allowWrite: deps.allowWrite, prodValidateEnabled: deps.prodValidateEnabled, claims, tool: KNOWLEDGE_ACCESS }).allow) {
      if (deps.knowledge) registerKnowledgeResources(server, deps.knowledge.docs, principal, deps);
      registerPrompts(server, principal, deps);
    }
    return server;
  };
}

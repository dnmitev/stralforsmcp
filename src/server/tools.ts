import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import type { Audit, AuditInput } from '../audit/index.ts';
import type { Env, Principal } from '../auth/index.ts';
import { withPrincipal } from './context.ts';
import { StralforsError, type StralforsErrorKind } from '../stralfors/errors.ts';
import { decide, visibleTools, type DenyReason, type ScopeHolder, type ToolSpec } from '../policy/index.ts';

export interface ToolContext { principal: Principal; env: Env; allowWrite: boolean; visible: ToolSpec[] }

export interface ToolDef<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  spec: ToolSpec;
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  run(args: z.infer<I>, ctx: ToolContext): Promise<z.infer<O>>;
}

export interface RegistryDeps { env: Env; allowWrite: boolean; audit: Audit; now?: () => number; claims?: ScopeHolder }

export const DENIED_TEXT = (reason: DenyReason) => `not allowed: ${reason}`;
export const ERROR_TEXT = 'tool failed';

export const KIND_TEXT = (kind: StralforsErrorKind) => `tool failed: ${kind}`;

/** A tool refusing its own arguments before any upstream call. message is a fixed text, never the argument value. */
export class ToolInputError extends Error { override readonly name = 'ToolInputError' }

const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/** Policy re-check, one audit line, sanitised errors. Arguments and results never reach the audit. */
export async function callTool(def: ToolDef, args: unknown, principal: Principal, deps: RegistryDeps, visible?: ToolSpec[]): Promise<CallToolResult> {
  const now = deps.now ?? Date.now;
  const start = now();
  const ctx = { principal, env: deps.env, allowWrite: deps.allowWrite, claims: deps.claims };
  const record = (r: Pick<AuditInput, 'outcome' | 'reason' | 'traceId'>) => deps.audit.record({ principal, tool: def.spec.name, env: deps.env, durationMs: Math.max(0, Math.round(now() - start)), ...r });
  const d = decide({ ...ctx, tool: def.spec });
  if (!d.allow) {
    record({ outcome: 'denied', reason: d.reason });
    return fail(DENIED_TEXT(d.reason));
  }
  try {
    const out = await withPrincipal(principal, () => def.run(args as never, { ...ctx, visible: visible ?? visibleTools(ctx, [def.spec]) }));
    record({ outcome: 'allowed' });
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  } catch (e) {
    if (e instanceof ToolInputError) {
      record({ outcome: 'error', reason: 'bad_input' });
      return fail(e.message);
    }
    if (e instanceof StralforsError) {
      record({ outcome: 'error', reason: e.kind, ...(e.traceId === undefined ? {} : { traceId: e.traceId }) });
      return fail(KIND_TEXT(e.kind));
    }
    record({ outcome: 'error', reason: 'error' });
    return fail(ERROR_TEXT);
  }
}

/** Registers every tool visibleTools() allows, each wrapped by callTool. */
export function registerAll(server: McpServer, principal: Principal, tools: ToolDef[], deps: RegistryDeps): ToolSpec[] {
  const visible = visibleTools({ principal, env: deps.env, allowWrite: deps.allowWrite, claims: deps.claims }, tools.map((t) => t.spec));
  const shown = tools.filter((t) => visible.includes(t.spec));
  for (const def of shown) {
    server.registerTool(def.spec.name, { title: def.title, description: def.description, inputSchema: def.inputSchema, outputSchema: def.outputSchema, annotations: def.annotations }, (args) => callTool(def, args, principal, deps, visible));
  }
  return visible;
}

import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import type { Audit, AuditInput } from '../audit/index.ts';
import type { Env, Principal } from '../auth/index.ts';
import { withPrincipal } from './context.ts';
import { ConfigError, StralforsError, type StralforsErrorKind } from '../stralfors/errors.ts';
import { setSafe, withSpan, type Telemetry } from '../telemetry/index.ts';
import { decide, visibleTools, type DenyReason, type ScopeHolder, type ToolSpec } from '../policy/index.ts';

export interface ToolContext { principal: Principal; env: Env; allowWrite: boolean; prodValidateEnabled: boolean; visible: ToolSpec[] }

export interface ToolDef<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  spec: ToolSpec;
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  run(args: z.infer<I>, ctx: ToolContext): Promise<z.infer<O>>;
}

export interface RegistryDeps { env: Env; allowWrite: boolean; prodValidateEnabled: boolean; audit: Audit; now?: () => number; claims?: ScopeHolder; telemetry?: Telemetry; maxOutputBytes?: number }

export const DENIED_TEXT = (reason: DenyReason) => `not allowed: ${reason}`;
export const ERROR_TEXT = 'tool failed';
export const TOO_LARGE_TEXT = 'tool output too large; narrow the request';
export const DEFAULT_MAX_OUTPUT_BYTES = 262_144;

export const KIND_TEXT = (kind: StralforsErrorKind) => `tool failed: ${kind}`;

/** A tool refusing its own arguments before any upstream call. message is a fixed text, never the argument value. */
export class ToolInputError extends Error { override readonly name = 'ToolInputError' }

const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/** Policy re-check, one audit line, sanitised errors. Arguments and results never reach the audit. */
export async function callTool(def: ToolDef, args: unknown, principal: Principal, deps: RegistryDeps, visible?: ToolSpec[]): Promise<CallToolResult> {
  const tel = deps.telemetry;
  if (!tel) return run(def, args, principal, deps, visible);
  return withSpan(tel.tracer, `mcp.tool ${def.spec.name}`, SpanKind.INTERNAL, { tool: def.spec.name, env: deps.env }, (span) => run(def, args, principal, deps, visible, span), () => 'error');
}

async function run(def: ToolDef, args: unknown, principal: Principal, deps: RegistryDeps, visible?: ToolSpec[], span?: Span): Promise<CallToolResult> {
  const now = deps.now ?? Date.now;
  const start = now();
  const ctx = { principal, env: deps.env, allowWrite: deps.allowWrite, prodValidateEnabled: deps.prodValidateEnabled, claims: deps.claims };
  const record = (r: Pick<AuditInput, 'outcome' | 'reason' | 'traceId'>) => {
    const ms = now() - start;
    deps.audit.record({ principal, tool: def.spec.name, env: deps.env, durationMs: Math.max(0, Math.round(ms)), ...r });
    const tel = deps.telemetry;
    if (!span || !tel) return;
    setSafe(span, { outcome: r.outcome, ...(r.reason === undefined ? {} : { 'error.type': r.reason }) });
    if (r.outcome === 'error') span.setStatus({ code: SpanStatusCode.ERROR });
    tel.instruments.toolCalls.add(1, { tool: def.spec.name, outcome: r.outcome, env: deps.env });
    tel.instruments.toolDuration.record(Math.max(0, ms) / 1000, { tool: def.spec.name, outcome: r.outcome });
  };
  const d = decide({ ...ctx, tool: def.spec });
  if (!d.allow) {
    record({ outcome: 'denied', reason: d.reason });
    return fail(DENIED_TEXT(d.reason));
  }
  try {
    const out = await withPrincipal(principal, () => def.run(args as never, { ...ctx, visible: visible ?? visibleTools(ctx, [def.spec]) }));
    const body = JSON.stringify(out);
    if (Buffer.byteLength(body) > (deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) { // refuse, never truncate: a half answer misleads
      record({ outcome: 'error', reason: 'too_large' });
      return fail(TOO_LARGE_TEXT);
    }
    record({ outcome: 'allowed' });
    return { content: [{ type: 'text', text: body }], structuredContent: out };
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

/** A scoped or write tool without claims would be denied on every call; fail at construction instead. Names only in the message. */
export function assertClaimsWired(tools: ToolDef[], claims?: ScopeHolder): void {
  for (const { spec } of tools) if (!claims && (spec.requiredScope !== undefined || spec.access === 'write')) throw new ConfigError(`tool ${spec.name} needs a scope but claims are not wired`);
}

/** Registers every tool visibleTools() allows, each wrapped by callTool. */
export function registerAll(server: McpServer, principal: Principal, tools: ToolDef[], deps: RegistryDeps): ToolSpec[] {
  assertClaimsWired(tools, deps.claims);
  const visible = visibleTools({ principal, env: deps.env, allowWrite: deps.allowWrite, prodValidateEnabled: deps.prodValidateEnabled, claims: deps.claims }, tools.map((t) => t.spec));
  const shown = tools.filter((t) => visible.includes(t.spec));
  for (const def of shown) {
    server.registerTool(def.spec.name, { title: def.title, description: def.description, inputSchema: def.inputSchema, outputSchema: def.outputSchema, annotations: def.annotations }, (args) => callTool(def, args, principal, deps, visible));
  }
  return visible;
}

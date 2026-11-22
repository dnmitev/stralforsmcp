import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import type { Audit, AuditInput, AuditReason } from '../audit/index.ts';
import type { Env, Principal } from '../auth/index.ts';
import { withSignal } from '../stralfors/abort.ts';
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

export interface RegistryDeps { env: Env; allowWrite: boolean; prodValidateEnabled: boolean; audit: Audit; now?: () => number; /** The claims of the caller this registry serves; resolved per request by buildMcp, never process-wide. */ claims?: ScopeHolder; telemetry?: Telemetry; maxOutputBytes?: number }

export const DENIED_TEXT = (reason: DenyReason) => `not allowed: ${reason}`;
export const ERROR_TEXT = 'tool failed';
export const TOO_LARGE_TEXT = 'tool output too large; narrow the request';
export const DEFAULT_MAX_OUTPUT_BYTES = 262_144;

export const KIND_TEXT = (kind: StralforsErrorKind) => `tool failed: ${kind}`;

/** What a tool may put on its own refusal: fixed codes only. `invalid_input` is reserved for SDK schema rejection (auditInvalid). */
export type InputReason = Extract<AuditReason, 'bad_input' | 'not_found' | 'timeout' | 'agreement_not_found'>;

/** A tool refusing its own arguments before any upstream call. message is a fixed text, never the argument value. */
export class ToolInputError extends Error {
  override readonly name = 'ToolInputError';
  /** The audit reason: a fixed code, never an argument value. */
  readonly reason: InputReason;
  constructor(message: string, reason: InputReason = 'bad_input') {
    super(message);
    this.reason = reason;
  }
}

const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/** Policy re-check, one audit line, sanitised errors. Arguments and results never reach the audit. */
/** `signal` is the MCP request's abort signal: upstream requests the tool starts are aborted with it (CancelledError, audited `cancelled`). */
export async function callTool(def: ToolDef, args: unknown, principal: Principal, deps: RegistryDeps, visible?: ToolSpec[], signal?: AbortSignal): Promise<CallToolResult> {
  const tel = deps.telemetry;
  if (!tel) return run(def, args, principal, deps, visible, undefined, signal);
  return withSpan(tel.tracer, `mcp.tool ${def.spec.name}`, SpanKind.INTERNAL, { tool: def.spec.name, env: deps.env }, (span) => run(def, args, principal, deps, visible, span, signal), () => 'error');
}

async function run(def: ToolDef, args: unknown, principal: Principal, deps: RegistryDeps, visible?: ToolSpec[], span?: Span, signal?: AbortSignal): Promise<CallToolResult> {
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
    const out = await withPrincipal(principal, () => withSignal(signal, () => def.run(args as never, { ...ctx, visible: visible ?? visibleTools(ctx, [def.spec]) })));
    const body = JSON.stringify(out);
    if (Buffer.byteLength(body) > (deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) { // refuse, never truncate: a half answer misleads
      record({ outcome: 'error', reason: 'too_large' });
      return fail(TOO_LARGE_TEXT);
    }
    record({ outcome: 'allowed' });
    return { content: [{ type: 'text', text: body }], structuredContent: out };
  } catch (e) {
    if (e instanceof ToolInputError) {
      record({ outcome: 'error', reason: e.reason });
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
export const needsScope = (spec: ToolSpec): boolean => spec.requiredScope !== undefined || spec.access === 'write';
export function assertClaimsWired(tools: ToolDef[], claims?: unknown): void {
  for (const { spec } of tools) if (!claims && needsScope(spec)) throw new ConfigError(`tool ${spec.name} needs a scope but claims are not wired`);
}

/** Registers every tool visibleTools() allows, each wrapped by callTool. */
export function registerAll(server: McpServer, principal: Principal, tools: ToolDef[], deps: RegistryDeps): ToolSpec[] {
  assertClaimsWired(tools, deps.claims);
  const visible = visibleTools({ principal, env: deps.env, allowWrite: deps.allowWrite, prodValidateEnabled: deps.prodValidateEnabled, claims: deps.claims }, tools.map((t) => t.spec));
  const shown = tools.filter((t) => visible.includes(t.spec));
  for (const def of shown) {
    server.registerTool(def.spec.name, { title: def.title, description: def.description, inputSchema: auditInvalid(def, principal, deps), outputSchema: def.outputSchema, annotations: def.annotations }, (args, extra) => callTool(def, args, principal, deps, visible, extra.mcpReq.signal));
  }
  return visible;
}

/**
 * The SDK validates input before the handler, so a schema failure never reaches callTool. This wraps the schema's own
 * Standard Schema `validate` (a public interface) and audits a failure as error/invalid_input; the issues and the
 * arguments are not looked at, and the SDK still produces the same rejection.
 */
function auditInvalid(def: ToolDef, principal: Principal, deps: RegistryDeps): ToolDef['inputSchema'] {
  return onInvalid(def.inputSchema, () => {
    deps.audit.record({ principal, tool: def.spec.name, env: deps.env, outcome: 'error', reason: 'invalid_input', durationMs: 0 });
    deps.telemetry?.instruments.toolCalls.add(1, { tool: def.spec.name, outcome: 'error', env: deps.env });
  });
}

/** Calls `failed` whenever the schema rejects a value; the value and the issues are never passed on. Shared with the prompt schemas. */
export function onInvalid<S extends { '~standard': { validate: (v: unknown) => unknown } }>(schema: S, failed: () => void): S {
  const std = schema['~standard'];
  const check = <R extends { issues?: unknown }>(r: R): R => {
    if (r.issues) failed();
    return r;
  };
  const wrapped = new Proxy(std, { get: (t, k) => (k === 'validate' ? (v: unknown) => { const r = t.validate(v) as { issues?: unknown } | Promise<{ issues?: unknown }>; return r instanceof Promise ? r.then(check) : check(r) } : Reflect.get(t, k)) });
  return new Proxy(schema, { get: (t, k) => (k === '~standard' ? wrapped : Reflect.get(t, k)) });
}

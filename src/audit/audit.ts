import { pino } from 'pino';
import type { Principal, Role, VerifyCode } from '../auth/index.ts';
import type { StralforsErrorKind } from '../stralfors/errors.ts';
import type { DenyReason } from '../policy/index.ts';

export type Outcome = 'allowed' | 'denied' | 'blocked' | 'error';
/** A fixed code: a deny reason, a verify code, a StralforsError kind, 'write_guard' or 'error'. Never free text. */
export type AuditReason = DenyReason | VerifyCode | StralforsErrorKind | 'write_guard' | 'error' | 'bad_input' | 'too_large';

export interface AuditInput {
  principal?: Principal;
  tool: string;
  env: 'test' | 'prod';
  outcome: Outcome;
  reason?: AuditReason;
  durationMs: number;
  traceId?: string;
}
export interface AuditEvent {
  ts: string;
  userId: string;
  role: Role | 'anonymous';
  tool: string;
  env: 'test' | 'prod';
  outcome: Outcome;
  reason?: AuditReason;
  durationMs: number;
  traceId?: string;
  trace_id?: string;
}
// `traceId` is the vendor's request id (from upstream error bodies); `trace_id` is this server's OpenTelemetry trace id (32 hex).
export const AUDIT_KEYS = ['ts', 'userId', 'role', 'tool', 'env', 'outcome', 'reason', 'durationMs', 'traceId', 'trace_id'] as const;

export interface Audit { record(input: AuditInput): AuditEvent }

/** First 4 + "…" + last 4 for ids of 16+ chars; anything shorter is fully hidden. */
export const mask = (id: string): string => (id.length >= 16 ? `${id.slice(0, 4)}…${id.slice(-4)}` : '…');

export function createAudit(o: { destination: { write(chunk: string): void }; now: () => number; otelTraceId?: () => string | undefined }): Audit {
  const p = pino({ base: { 'log.type': 'audit' }, timestamp: false }, o.destination);
  return {
    record(i) {
      const otel = o.otelTraceId?.();
      const ev: AuditEvent = {
        ts: new Date(o.now()).toISOString(),
        userId: i.principal?.userId ?? 'anonymous',
        role: i.principal?.role ?? 'anonymous',
        tool: i.tool,
        env: i.env,
        outcome: i.outcome,
        ...(i.reason === undefined ? {} : { reason: i.reason }),
        durationMs: i.durationMs,
        ...(i.traceId === undefined ? {} : { traceId: i.traceId }),
        ...(otel ? { trace_id: otel } : {}),
      };
      p.info(ev);
      return ev;
    },
  };
}

// Path segments of the known Stralfors routes; anything else (an id in a path) becomes `*`, so the audit tool field cannot carry identifiers.
const ROUTE_WORDS = new Set(['rest', 'outputmanagement', 'apiomni', 'v1', 'v2', 'invoices', 'channels', 'templates', 'rules', 'document', 'validate', 'apiinfo', 'manage', 'health', 'oidc', 'token', 'true', 'false']);
// The query is dropped: its keys are caller-defined and could carry identifiers.
const safePath = (t: string) => t.split('?')[0]!.split('/').map((s) => (s === '' || ROUTE_WORDS.has(s) ? s : '*')).join('/');

/** Adapter for `onBlocked`: the caller merges principal and env. */
export const fromBlocked = (e: { profile: string; method: string; pathTemplate: string }): Pick<AuditInput, 'tool' | 'outcome' | 'reason' | 'durationMs'> => ({
  tool: `${e.method} ${safePath(e.pathTemplate)}`, outcome: 'blocked', reason: 'write_guard', durationMs: 0,
});

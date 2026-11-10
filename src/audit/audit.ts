import { pino } from 'pino';
import type { Principal, Role, VerifyCode } from '../auth/index.ts';
import type { DenyReason } from '../policy/index.ts';

export type Outcome = 'allowed' | 'denied' | 'blocked' | 'error';
/** A fixed code: a deny reason, a verify code, 'write_guard' or a StralforsError kind. Never free text. */
export type AuditReason = DenyReason | VerifyCode | 'write_guard' | (string & {});

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
  reason?: string;
  durationMs: number;
  traceId?: string;
}
export const AUDIT_KEYS = ['ts', 'userId', 'role', 'tool', 'env', 'outcome', 'reason', 'durationMs', 'traceId'] as const;

export interface Audit { record(input: AuditInput): AuditEvent }

/** First 4 + "…" + last 4 for ids of 16+ chars; anything shorter is fully hidden. */
export const mask = (id: string): string => (id.length >= 16 ? `${id.slice(0, 4)}…${id.slice(-4)}` : '…');

export function createAudit(o: { destination: { write(chunk: string): void }; now: () => number }): Audit {
  const p = pino({ base: { 'log.type': 'audit' }, timestamp: false }, o.destination);
  return {
    record(i) {
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
      };
      p.info(ev);
      return ev;
    },
  };
}

/** Adapter for `onBlocked`: the caller merges principal and env. */
export const fromBlocked = (e: { profile: string; method: string; pathTemplate: string }): Pick<AuditInput, 'tool' | 'outcome' | 'reason' | 'durationMs'> => ({
  tool: `${e.method} ${e.pathTemplate}`, outcome: 'blocked', reason: 'write_guard', durationMs: 0,
});

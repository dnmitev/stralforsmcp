import { inspect } from 'node:util';

export interface Violation {
  ruleId?: string;
  tag?: string;
  path: string;
  criteria: string[];
  serverError?: true;
}
export type StralforsErrorKind =
  | 'config' | 'tls' | 'auth' | 'forbidden' | 'agreement_not_found' | 'route_not_found' | 'bad_request'
  | 'validation_failed' | 'conflict' | 'rate_limited' | 'upstream' | 'timeout' | 'too_large' | 'schema'
  | 'write_blocked' | 'token_format' | 'request_invalid';
interface Base {
  status?: number;
  traceId?: string;
  profile?: string;
  operation?: string;
}

/** `message` is always the safe message: it never carries header values, body text, secrets or identity ids. */
export class StralforsError extends Error {
  kind: StralforsErrorKind;
  status?: number;
  traceId?: string;
  profile?: string;
  operation?: string;
  constructor(kind: StralforsErrorKind, message: string, props: Base = {}) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    Object.assign(this, props);
    // Fault payloads carry agreement and identity ids: keep them readable by name but out of spread, Object.keys and serializers.
    for (const k of ['faults', 'errors', 'detail', 'actionId']) if (k in props) Object.defineProperty(this, k, { enumerable: false });
  }
  toJSON() {
    return { name: this.name, kind: this.kind, message: this.message, status: this.status, traceId: this.traceId, profile: this.profile, operation: this.operation };
  }
  [inspect.custom](): string {
    return this.stack as string;
  }
}

const make = <E extends object = object>(kind: StralforsErrorKind) =>
  class extends StralforsError {
    constructor(message: string, props: Base & E = {} as Base & E) {
      super(kind, message, props);
    }
  } as unknown as new (message: string, props?: Base & E) => StralforsError & E;

export class ConfigError extends make('config') {}
export class TlsError extends make('tls') {}
export class AuthError extends make<{ detail?: string }>('auth') {}
export class ForbiddenError extends make('forbidden') {}
export class AgreementNotFoundError extends make<{ actionId?: string }>('agreement_not_found') {}
export class RouteNotFoundError extends make('route_not_found') {}
export class BadRequestError extends make<{ errors?: Record<string, string[]> }>('bad_request') {}
export class ValidationFailedError extends make<{ violations: Violation[]; faults: unknown[] }>('validation_failed') {}
export class ConflictError extends make('conflict') {}
export class RateLimitedError extends make<{ retryAfterMs?: number }>('rate_limited') {}
export class UpstreamError extends make('upstream') {}
export class TimeoutError extends make('timeout') {}
export class ResponseTooLargeError extends make('too_large') {}
export class SchemaError extends make<{ issues: { path: string }[] }>('schema') {}
export class WriteBlockedError extends make('write_blocked') {}
export class TokenFormatError extends make('token_format') {}
export class RequestValidationError extends make<{ fields: string[] }>('request_invalid') {}

const PARAM = /^#(\d+)(?::([^:]+))?:(.+)$/;
const ENGINE = 'Unexpected error occurred';

function violation(pv: unknown): Violation {
  if (typeof pv === 'string') return { path: pv, criteria: [] };
  const { param: p, value: val } = (pv ?? {}) as { param?: unknown; value?: unknown };
  const param = typeof p === 'string' ? p : '';
  const value = typeof val === 'string' ? val : '';
  const m = PARAM.exec(param);
  const parts = value.split(' | ').map((s) => s.trim()).filter(Boolean);
  const criteria = parts.filter((c) => !c.startsWith(ENGINE));
  const v: Violation = { ruleId: m?.[1], tag: m?.[2], path: m ? m[3]! : param, criteria };
  if (criteria.length < parts.length) v.serverError = true;
  return v;
}

export function mapHttpError(
  res: { status: number; contentType?: string; body: string; retryAfter?: string },
  ctx: { profile: string; operation: string },
): StralforsError {
  let j: Record<string, any> | undefined;
  if (res.contentType?.includes('json')) {
    try {
      j = JSON.parse(res.body);
    } catch {}
  }
  const { status } = res;
  const traceId = typeof j?.['traceId'] === 'string' ? j['traceId'] : undefined;
  const p = { ...ctx, status, traceId };
  const msg = `HTTP ${status}`;
  switch (status) {
    case 400: {
      const faults: unknown[] | undefined = j?.['compositeFault']?.faults;
      if (Array.isArray(faults)) {
        const violations = faults.flatMap((f) => {
          const pvs = (f as { paramValues?: unknown } | null)?.paramValues;
          return Array.isArray(pvs) ? pvs.map(violation) : [];
        });
        return new ValidationFailedError(`validation failed: ${violations.length} violation(s)`, { ...p, violations, faults });
      }
      const errors = j?.['errors'];
      return new BadRequestError(`bad request: ${errors ? Object.keys(errors).length : 0} field(s)`, { ...p, errors });
    }
    case 401:
      return new AuthError(`${msg}: unauthorized`, p);
    case 403:
      return new ForbiddenError(`${msg}: forbidden`, p);
    case 404:
      if (!j) return new RouteNotFoundError(`${msg}: route not found`, p);
      return new AgreementNotFoundError(`${msg}: agreement not found`, { ...p, actionId: /action ?id '([^']+)'/i.exec(String(j['message']))?.[1] });
    case 409:
      return new ConflictError(`${msg}: conflict`, p);
    case 429: {
      // Stryker disable next-line StringLiteral: any non-numeric fallback parses to NaN, same as ''
      const ra = res.retryAfter ?? '';
      // Stryker disable next-line Regex: an unanchored digit match is only true for strings Number() turns into NaN, which becomes undefined below, same as the Date.parse path
      const ms = /^\d+$/.test(ra) ? Number(ra) * 1000 : Date.parse(ra) - Date.now();
      return new RateLimitedError(`${msg}: rate limited`, { ...p, retryAfterMs: ms >= 0 ? ms : undefined });
    }
    default:
      return new UpstreamError(`${msg}: upstream error`, p);
  }
}

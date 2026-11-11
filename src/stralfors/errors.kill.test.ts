// Mutation-hardening for R7: exact kinds, messages, status table, non-enumerability, violation parsing, Retry-After arithmetic.
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgreementNotFoundError, AuthError, BadRequestError, ConflictError, ConfigError, ForbiddenError, RateLimitedError,
  RequestValidationError, ResponseTooLargeError, RouteNotFoundError, SchemaError, StralforsError, TimeoutError, TlsError,
  TokenFormatError, UpstreamError, ValidationFailedError, WriteBlockedError, mapHttpError,
} from './errors.ts';

const ctx = { profile: 'a', operation: 'op' };
const JSON_CT = 'application/json';
const map = (status: number, body = '', contentType: string | null = JSON_CT, retryAfter?: string) =>
  mapHttpError({ status, contentType: contentType ?? undefined, body, retryAfter }, ctx);
const pvBody = (...paramValues: unknown[]) => JSON.stringify({ compositeFault: { faults: [{ paramValues }] } });

afterEach(() => vi.useRealTimers());

describe('R7 class kinds', () => {
  it.each([
    [ConfigError, 'config'], [TlsError, 'tls'], [AuthError, 'auth'], [ForbiddenError, 'forbidden'],
    [AgreementNotFoundError, 'agreement_not_found'], [RouteNotFoundError, 'route_not_found'], [BadRequestError, 'bad_request'],
    [ConflictError, 'conflict'], [RateLimitedError, 'rate_limited'], [UpstreamError, 'upstream'], [TimeoutError, 'timeout'],
    [ResponseTooLargeError, 'too_large'], [SchemaError, 'schema'], [WriteBlockedError, 'write_blocked'],
    [TokenFormatError, 'token_format'], [RequestValidationError, 'request_invalid'], [ValidationFailedError, 'validation_failed'],
  ] as const)('%o has its kind', (Cls, kind) => {
    const e = new (Cls as unknown as new (m: string) => StralforsError)('m');
    expect(e.kind).toBe(kind);
    expect(e.name).toBe(Cls.name);
    expect(e).toBeInstanceOf(StralforsError);
  });
});

describe('R7 StralforsError serialisation', () => {
  it.each(['faults', 'errors', 'detail', 'actionId'])('%s is readable but non-enumerable', (k) => {
    const e = new StralforsError('upstream', 'm', { [k]: 'v' } as never);
    expect((e as unknown as Record<string, unknown>)[k]).toBe('v');
    expect(Object.keys(e)).not.toContain(k);
    expect(Object.keys({ ...e })).not.toContain(k);
    expect(Object.getOwnPropertyDescriptor(e, k)?.enumerable).toBe(false);
  });

  it('absent payload keys are not defined at all', () => {
    const e = new UpstreamError('m', { status: 500 });
    for (const k of ['faults', 'errors', 'detail', 'actionId']) expect(k in e).toBe(false);
  });

  it('other props stay enumerable', () => {
    const e = new StralforsError('upstream', 'm', { status: 500, traceId: 't', profile: 'a', operation: 'o' });
    expect(Object.keys(e)).toEqual(expect.arrayContaining(['kind', 'status', 'traceId', 'profile', 'operation']));
  });

  it('toJSON is exactly the safe fields', () => {
    const e = new AuthError('msg', { status: 401, traceId: 't', profile: 'a', operation: 'o', detail: 'secretish' });
    expect(JSON.parse(JSON.stringify(e))).toEqual({ name: 'AuthError', kind: 'auth', message: 'msg', status: 401, traceId: 't', profile: 'a', operation: 'o' });
  });

  it('inspect; message is the safe message and safeMessage is gone', () => {
    const e = new UpstreamError('boom', { status: 500 });
    expect(inspect(e)).toBe(e.stack);
    expect(e.message).toBe('boom');
    expect('safeMessage' in e).toBe(false);
  });
});

describe('R7 status table', () => {
  it.each([
    [401, AuthError, 'HTTP 401: unauthorized'], [403, ForbiddenError, 'HTTP 403: forbidden'], [409, ConflictError, 'HTTP 409: conflict'],
    [429, RateLimitedError, 'HTTP 429: rate limited'], [500, UpstreamError, 'HTTP 500: upstream error'],
    [502, UpstreamError, 'HTTP 502: upstream error'], [418, UpstreamError, 'HTTP 418: upstream error'],
    [300, UpstreamError, 'HTTP 300: upstream error'], [402, UpstreamError, 'HTTP 402: upstream error'],
  ] as const)('%i', (status, Cls, message) => {
    const e = map(status, JSON.stringify({ traceId: 'tr-1' }));
    expect(e).toBeInstanceOf(Cls);
    expect(e.message).toBe(message);
    expect([e.status, e.traceId, e.profile, e.operation]).toEqual([status, 'tr-1', 'a', 'op']);
  });

  it('non-string traceId is ignored', () => {
    expect(map(500, JSON.stringify({ traceId: 5 })).traceId).toBeUndefined();
  });

  it('404 without JSON is a route miss', () => {
    const e = map(404, 'No Mapping Rule matched', 'text/plain');
    expect(e).toBeInstanceOf(RouteNotFoundError);
    expect(e.message).toBe('HTTP 404: route not found');
  });

  it('404 with a JSON body in a non-JSON content type is still a route miss', () => {
    expect(map(404, JSON.stringify({ message: "Action id 'x' not found" }), 'text/plain')).toBeInstanceOf(RouteNotFoundError);
    expect(map(404, JSON.stringify({ message: 'm' }), null)).toBeInstanceOf(RouteNotFoundError);
  });

  it('404 with JSON is an agreement miss; the id is extracted when present', () => {
    const e = map(404, JSON.stringify({ message: "Action id 'abc-1' not found" })) as AgreementNotFoundError;
    expect(e).toBeInstanceOf(AgreementNotFoundError);
    expect(e.message).toBe('HTTP 404: agreement not found');
    expect(e.actionId).toBe('abc-1');
    expect((map(404, JSON.stringify({ message: 'nothing here' })) as AgreementNotFoundError).actionId).toBeUndefined();
    expect((map(404, JSON.stringify({})) as AgreementNotFoundError).actionId).toBeUndefined();
  });

  it('a missing content type never throws', () => {
    expect(() => map(400, '{}', null)).not.toThrow();
    expect(map(500, JSON.stringify({ traceId: 't' }), null).traceId).toBeUndefined();
  });

  it('400 with an unparseable body is a bad request with zero fields', () => {
    const e = map(400, 'not json', JSON_CT) as BadRequestError;
    expect(e).toBeInstanceOf(BadRequestError);
    expect(e.message).toBe('bad request: 0 field(s)');
    expect(map(400, 'x', 'text/plain')).toBeInstanceOf(BadRequestError);
  });

  it('400 with errors counts the fields', () => {
    const e = map(400, JSON.stringify({ errors: { a: ['x'], b: ['y'] } })) as BadRequestError;
    expect(e.message).toBe('bad request: 2 field(s)');
    expect(e.errors).toEqual({ a: ['x'], b: ['y'] });
    expect(Object.keys(e)).not.toContain('errors');
  });

  it('400 compositeFault is a validation failure with a violation count', () => {
    const e = map(400, pvBody({ param: '#1:t:p', value: 'a' }, { param: '#2:t:q', value: 'b' })) as ValidationFailedError;
    expect(e).toBeInstanceOf(ValidationFailedError);
    expect(e.message).toBe('validation failed: 2 violation(s)');
    expect(e.violations).toHaveLength(2);
    expect(e.faults).toHaveLength(1);
  });

  it('400 compositeFault without faults array falls back to bad request', () => {
    expect(map(400, JSON.stringify({ compositeFault: {} }))).toBeInstanceOf(BadRequestError);
    expect(map(400, JSON.stringify({ compositeFault: { faults: 'x' } }))).toBeInstanceOf(BadRequestError);
  });
});

describe('R7 violation parsing', () => {
  const v = (...pv: unknown[]) => (map(400, pvBody(...pv)) as ValidationFailedError).violations;

  it('splits rule id, tag, path and criteria', () => {
    expect(v({ param: '#12:RuleTag:data.field', value: 'first | second' })).toEqual([
      { ruleId: '12', tag: 'RuleTag', path: 'data.field', criteria: ['first', 'second'] },
    ]);
  });

  it('tag is optional', () => {
    expect(v({ param: '#3:data.field', value: 'c' })).toEqual([{ ruleId: '3', tag: undefined, path: 'data.field', criteria: ['c'] }]);
  });

  it('a param that does not match the pattern is the path as is', () => {
    expect(v({ param: 'x#1:t:p', value: 'c' })[0]).toMatchObject({ path: 'x#1:t:p', ruleId: undefined, tag: undefined });
    expect(v({ param: '#1:t:p\nrest', value: 'c' })[0]).toMatchObject({ path: '#1:t:p\nrest', ruleId: undefined });
  });

  it('non-string param and value become empty', () => {
    expect(v({ param: 5, value: 7 })).toEqual([{ ruleId: undefined, tag: undefined, path: '', criteria: [] }]);
  });

  it('plain string entries are paths', () => {
    expect(v('some.path')).toEqual([{ path: 'some.path', criteria: [] }]);
  });

  it('criteria are trimmed and empties dropped', () => {
    expect(v({ param: 'p', value: 'a  |  b' })[0]!.criteria).toEqual(['a', 'b']);
    expect(v({ param: 'p', value: 'a |  | b' })[0]!.criteria).toEqual(['a', 'b']);
  });

  it('engine noise is dropped and flagged', () => {
    const one = v({ param: 'p', value: 'real | Unexpected error occurred: x' })[0]!;
    expect(one.criteria).toEqual(['real']);
    expect(one.serverError).toBe(true);
    expect(v({ param: 'p', value: 'real' })[0]).not.toHaveProperty('serverError');
  });

  it('null faults and non-array paramValues yield no violations, not a TypeError', () => {
    const e = map(400, JSON.stringify({ compositeFault: { faults: [null, { paramValues: 'x' }, {}] } })) as ValidationFailedError;
    expect(e.violations).toEqual([]);
    expect(map(400, pvBody(null))).toBeInstanceOf(ValidationFailedError);
  });
});

describe('R7 Retry-After', () => {
  const ra = (v: string | undefined) => (map(429, '', JSON_CT, v) as RateLimitedError).retryAfterMs;

  it('delta seconds', () => {
    expect(ra('30')).toBe(30_000);
    expect(ra('0')).toBe(0);
  });

  it('absent or empty', () => {
    expect(ra(undefined)).toBeUndefined();
    expect(ra('')).toBeUndefined();
  });

  it('malformed values are not read as numbers', () => {
    expect(ra('abc30')).toBeUndefined();
    expect(ra('30abc')).toBeUndefined();
  });

  it('HTTP date in the future / now / past', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    expect(ra('Tue, 01 Jan 2030 00:01:00 GMT')).toBe(60_000);
    expect(ra('Tue, 01 Jan 2030 00:00:00 GMT')).toBe(0);
    expect(ra('Mon, 31 Dec 2029 23:59:00 GMT')).toBeUndefined();
  });
});

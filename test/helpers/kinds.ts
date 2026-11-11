// The 17 StralforsError subclasses with their kind literal, owned by the tests so that a new class or kind without a row here fails the count assertions.
import * as E from '../../src/stralfors/errors.ts';
import type { StralforsErrorKind } from '../../src/stralfors/errors.ts';

type Ctor = new (message: string, props?: Record<string, unknown>) => E.StralforsError;
export const KINDS = [
  [E.ConfigError, 'config'], [E.TlsError, 'tls'], [E.AuthError, 'auth'], [E.ForbiddenError, 'forbidden'],
  [E.AgreementNotFoundError, 'agreement_not_found'], [E.RouteNotFoundError, 'route_not_found'], [E.BadRequestError, 'bad_request'],
  [E.ValidationFailedError, 'validation_failed'], [E.ConflictError, 'conflict'], [E.RateLimitedError, 'rate_limited'],
  [E.UpstreamError, 'upstream'], [E.TimeoutError, 'timeout'], [E.ResponseTooLargeError, 'too_large'], [E.SchemaError, 'schema'],
  [E.WriteBlockedError, 'write_blocked'], [E.TokenFormatError, 'token_format'], [E.RequestValidationError, 'request_invalid'],
] as unknown as readonly (readonly [Ctor, StralforsErrorKind])[];

/** Classes exported by errors.ts that extend StralforsError (excluding the base). */
export const exportedKindClasses = (): Ctor[] =>
  (Object.values(E) as unknown[]).filter((v): v is Ctor => typeof v === 'function' && v !== E.StralforsError && v.prototype instanceof E.StralforsError);

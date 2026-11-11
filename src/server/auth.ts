import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Principal, TokenStore, VerifyCode } from '../auth/index.ts';

export const WWW_AUTHENTICATE = 'Bearer error="invalid_token"';
export const UNAUTHORIZED_BODY = '{"error":"invalid_token"}';

export type AuthResult = { ok: true; authInfo: AuthInfo } | { ok: false; code: VerifyCode };

/** AuthInfo for the SDK: token never retained, expiresAt in SECONDS (the SDK compares against seconds). */
export const toAuthInfo = (principal: Principal, expiresAtMs: number): AuthInfo => ({
  token: '', clientId: principal.userId, scopes: [], expiresAt: Math.floor(expiresAtMs / 1000), extra: { principal },
});

/** Pure: header to store.verify to AuthInfo. Anything that is not exactly `Bearer <token>` is verified as '' (malformed). Never throws. */
export function authenticate(authorization: string | undefined, store: TokenStore, at?: number): AuthResult {
  try {
    const m = /^Bearer (\S+)$/i.exec(authorization ?? '');
    const r = m ? store.verify(m[1]!, at) : store.verify('');
    return r.ok ? { ok: true, authInfo: toAuthInfo(r.principal, r.expiresAt) } : { ok: false, code: r.code };
  } catch {
    return { ok: false, code: 'unknown' };
  }
}

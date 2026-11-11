import { describe, expect, it } from 'vitest';
import { createTokenStore } from '../auth/index.ts';
import { authenticate } from './auth.ts';

describe('authenticate kill', () => {
  it('a missing header is malformed (verified as the empty string)', () => {
    const store = createTokenStore({ read: () => '{"users":[],"tokens":[]}', now: () => 0, setTimer: () => 'h', clearTimer: () => undefined });
    expect(authenticate(undefined, store)).toEqual({ ok: false, code: 'malformed' });
  });
});

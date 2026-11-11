/* Round 1 kill tests: every known route word survives the identifier scrubber. */
import { describe, expect, it } from 'vitest';
import { fromBlocked } from './index.ts';

const WORDS = ['rest', 'outputmanagement', 'apiomni', 'v1', 'v2', 'invoices', 'channels', 'templates', 'rules', 'document', 'validate', 'apiinfo', 'manage', 'health', 'oidc', 'token', 'true', 'false'];

describe('fromBlocked route words', () => {
  it.each(WORDS)('keeps %s, scrubs an unknown segment', (w) => {
    expect(fromBlocked({ profile: 'p', method: 'GET', pathTemplate: `/${w}/zz9` }).tool).toBe(`GET /${w}/*`);
  });
});

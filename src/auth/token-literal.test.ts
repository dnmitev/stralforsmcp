// R7: no committed token-shaped string; tokens are generated at run time.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('R7 no committed smcp_ token literal', () => {
  it('grep over src, test, docs and README finds nothing', () => {
    let out = '';
    try {
      out = execFileSync('grep', ['-rEn', 'smcp_[A-Za-z0-9_-]{43}', 'src', 'test', 'docs', 'README.md'], { encoding: 'utf8' });
    } catch (e) {
      if ((e as { status?: number }).status !== 1) throw e; // 1 = no match
    }
    expect(out).toBe('');
  });
});

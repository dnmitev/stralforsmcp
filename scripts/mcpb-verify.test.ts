import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { verifyMcpb } from './mcpb-verify.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const good = (): Record<string, Uint8Array> => ({
  'LICENSE': enc('licence'),
  'README.md': enc('readme'),
  'THIRD-PARTY-NOTICES': enc('notices'),
  'manifest.json': enc('{"version":"1.2.3"}'),
  'server/index.js': enc('console.log(1)'),
  'server/package.json': enc('{"type":"module"}'),
});
const zip = (e: Record<string, Uint8Array>) => zipSync(e);

describe('verifyMcpb', () => {
  it('accepts a complete archive', () => expect(verifyMcpb(zip(good()), '1.2.3')).toEqual([]));
  it('flags a version that differs from package.json', () => expect(verifyMcpb(zip(good()), '9.9.9').join()).toMatch(/version/));
  it('flags missing or empty LICENSE and THIRD-PARTY-NOTICES', () => {
    const a = good();
    delete a['LICENSE'];
    expect(verifyMcpb(zip(a), '1.2.3').join()).toMatch(/LICENSE/);
    const b = good();
    b['THIRD-PARTY-NOTICES'] = enc('');
    expect(verifyMcpb(zip(b), '1.2.3').join()).toMatch(/THIRD-PARTY-NOTICES/);
  });
  it('flags a source map reference', () => {
    const a = good();
    a['server/index.js'] = enc('x\n//# sourceMappingURL=index.js.map');
    expect(verifyMcpb(zip(a), '1.2.3').join()).toMatch(/source map/i);
  });
  it('flags unexpected entries, including credential-looking names', () => {
    for (const n of ['server/client.pem', 'server/.env', 'token-list.json', 'extra.txt']) {
      const a = good();
      a[n] = enc('x');
      expect(verifyMcpb(zip(a), '1.2.3').join(), n).toMatch(/unexpected/);
    }
  });
  it('flags an unreadable manifest', () => {
    const a = good();
    a['manifest.json'] = enc('not json');
    expect(verifyMcpb(zip(a), '1.2.3').join()).toMatch(/manifest/);
  });
});

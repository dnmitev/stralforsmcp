import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

describe('one app version', () => {
  const pkg = (JSON.parse(read('package.json')) as { version: string }).version;
  const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
  const manifest = (JSON.parse(read('extension/manifest.json')) as { version: string }).version;
  const appVersion = /^appVersion:\s*"?([^"\s#]+)"?/m.exec(read('charts/stralforsmcp/Chart.yaml'))?.[1];

  it('package.json is a plain semver version (no prerelease on main)', () => {
    expect(pkg).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  });
  it('package-lock.json, the extension manifest and the chart appVersion equal it', () => {
    expect(lock.version).toBe(pkg);
    expect(lock.packages['']?.version).toBe(pkg);
    expect(manifest).toBe(pkg);
    expect(appVersion).toBe(pkg);
  });
});

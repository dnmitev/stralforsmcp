import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ponytail: handles only the two pattern shapes used here (`/dir/` prefix, `/file` exact), not full CODEOWNERS globbing.
export function owners(text: string, path: string): string[] {
  let hit: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [pattern = '', ...who] = line.split(/\s+/);
    if (!pattern.startsWith('/')) continue;
    const p = pattern.slice(1);
    const match = pattern.endsWith('/') ? path.startsWith(p) : path === p;
    if (match) hit = who; // the last matching line wins, as on GitHub
  }
  return hit;
}

const TRUST_PATHS = [
  '.github/workflows/ci.yml',
  '.github/CODEOWNERS',
  '.claude/agents/principal-reviewer.md',
  '.claude/settings.json',
  '.githooks/pre-commit',
  '.gitignore',
  '.oxlintrc.json',
  '.nvmrc',
  'vitest.config.ts',
  'vitest.integration.config.ts',
  'vitest.stryker.config.ts',
  'stryker.config.json',
  'tsconfig.json',
  'scripts/workflow-policy.test.ts',
  'Dockerfile',
  '.dockerignore',
  '.trivyignore.yaml',
  '.gitleaks.toml',
  'charts/stralforsmcp/values.yaml',
  'extension/manifest.json',
  'docs/adr/0024-merge-gate-and-release-trust.md',
  'package.json',
  'package-lock.json',
];

describe('CODEOWNERS', () => {
  const text = readFileSync(join(import.meta.dirname, '..', '.github', 'CODEOWNERS'), 'utf8');

  it.each(TRUST_PATHS)('%s has an owner', (p) => {
    expect(owners(text, p)).toEqual(['@dnmitev']);
  });

  it('every rule is `/path owner`: no rule shape the test matcher would skip', () => {
    const rules = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r, r).toMatch(/^\/\S+ @\S+$/);
  });

  it('does not claim ordinary source files', () => {
    expect(owners(text, 'src/server/http.ts')).toEqual([]);
  });

  it('matcher: last match wins, prefix needs the slash, comments are ignored', () => {
    const t = '# /src/ @a\n/src/ @b\n/src/x.ts @c\n';
    expect(owners(t, 'src/y.ts')).toEqual(['@b']);
    expect(owners(t, 'src/x.ts')).toEqual(['@c']);
    expect(owners(t, 'srcx/y.ts')).toEqual([]);
  });
});

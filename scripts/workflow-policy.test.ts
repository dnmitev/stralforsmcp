import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHA = 'a'.repeat(40);
const UNTRUSTED =
  /\$\{\{[^}]*(github\.event\.pull_request\.(title|body|head\.ref)|github\.head_ref|github\.event\.comment\.|github\.event\.issue\.)[^}]*\}\}/;
const PINNED = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/;

const indentOf = (l: string): number => l.length - l.trimStart().length;
const isBlank = (l: string): boolean => l.trim() === '' || l.trim().startsWith('#');

// ponytail: line-based, not a YAML parser; assumes block-style YAML (no flow-style steps/run).
export function checkWorkflow(yamlText: string): string[] {
  const lines = yamlText.split(/\r?\n/);
  const out: string[] = [];
  const at = (i: number, msg: string): number => out.push(`line ${i + 1}: ${msg}`);

  if (!lines.some((l) => l.startsWith('permissions:'))) out.push('missing top-level permissions:');

  lines.forEach((l, i) => {
    if (l.trim().startsWith('#')) return;
    if (l.includes('pull_request_target')) at(i, 'pull_request_target trigger is forbidden');

    const u = /^\s*(?:- )?uses:\s*(\S+)(.*)$/.exec(l);
    if (u) {
      const [, ref = '', rest = ''] = u;
      if (!ref.startsWith('./') && !(PINNED.test(ref) && /^\s*(#.*)?$/.test(rest)))
        at(i, `action not pinned to a 40-hex SHA: ${ref}`);
      if (ref.startsWith('actions/checkout@')) {
        const col = l.indexOf('uses:');
        let s = i;
        while (s > 0 && !(/^\s*- /.test(lines[s] ?? '') && indentOf(lines[s] ?? '') < col)) s--;
        const dash = indentOf(lines[s] ?? '');
        let e = s + 1;
        while (e < lines.length && (isBlank(lines[e] ?? '') || indentOf(lines[e] ?? '') > dash)) e++;
        if (!/persist-credentials:\s*false/.test(lines.slice(s, e).join('\n')))
          at(i, 'actions/checkout without persist-credentials: false');
      }
    }

    const r = /^(\s*)(- )?run:\s*(.*)$/.exec(l);
    if (r) {
      const keyCol = (r[1] ?? '').length + (r[2] ? 2 : 0);
      const body = [r[3] ?? ''];
      if (/^[|>][+-]?\d*\s*$/.test(body[0] ?? '')) {
        body.length = 0;
        for (let j = i + 1; j < lines.length; j++) {
          const c = lines[j] ?? '';
          if (c.trim() !== '' && indentOf(c) <= keyCol) break;
          body.push(c);
        }
      }
      if (UNTRUSTED.test(body.join('\n'))) at(i, 'untrusted event data interpolated in run: (use env:)');
    }
  });
  return out;
}

const clean = `name: ci
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA} # v6.0.0
        with:
          persist-credentials: false
      - uses: ./.github/actions/local
      - name: Title
        env:
          T: \${{ github.event.pull_request.title }}
        run: echo "$T"
      - name: Multi
        run: |
          echo hi
          npm ci
`;

const swap = (a: string, b: string): string => {
  expect(clean).toContain(a);
  return clean.replace(a, b);
};

describe('checkWorkflow fixtures', () => {
  it('passes a clean workflow', () => {
    expect(checkWorkflow(clean)).toEqual([]);
  });

  it('flags pull_request_target', () => {
    expect(checkWorkflow(swap('pull_request:', 'pull_request_target:')).join()).toMatch(
      /pull_request_target/,
    );
  });

  it.each([
    ['tag ref', `actions/checkout@v4`],
    ['short sha', `actions/checkout@abc1234`],
    ['uppercase sha', `actions/checkout@${'A'.repeat(40)}`],
    ['branch ref', `actions/checkout@main`],
  ])('flags unpinned uses (%s)', (_n, ref) => {
    expect(checkWorkflow(swap(`actions/checkout@${SHA}`, ref)).join()).toMatch(/not pinned/);
  });

  it('flags non-comment trailing text after pinned uses', () => {
    expect(checkWorkflow(swap(`${SHA} # v6.0.0`, `${SHA} extra`)).join()).toMatch(/not pinned/);
  });

  it('flags missing top-level permissions (nested one does not count)', () => {
    const nested = swap('permissions:\n  contents: read\n', '').replace(
      '    runs-on: ubuntu-latest',
      '    runs-on: ubuntu-latest\n    permissions:\n      contents: read',
    );
    expect(checkWorkflow(nested).join()).toMatch(/permissions/);
  });

  it.each([
    'github.event.pull_request.title',
    'github.event.pull_request.body',
    'github.event.pull_request.head.ref',
    'github.head_ref',
    'github.event.comment.body',
    'github.event.issue.title',
  ])('flags %s in inline run', (expr) => {
    expect(checkWorkflow(swap('run: echo "$T"', `run: echo "\${{ ${expr} }}"`)).join()).toMatch(
      /run:/,
    );
  });

  it('flags untrusted data in a block run', () => {
    expect(
      checkWorkflow(swap('          echo hi\n', '          echo "${{ github.head_ref }}"\n')).join(),
    ).toMatch(/run:/);
  });

  it('allows untrusted data in env values only', () => {
    expect(checkWorkflow(clean)).toEqual([]);
  });

  it('flags checkout without persist-credentials: false', () => {
    expect(
      checkWorkflow(swap('        with:\n          persist-credentials: false\n', '')).join(),
    ).toMatch(/persist-credentials/);
  });

  it('does not credit persist-credentials from a different step', () => {
    const t = swap(
      '        with:\n          persist-credentials: false\n',
      '',
    ).replace(
      '      - uses: ./.github/actions/local',
      '      - uses: ./.github/actions/local\n        with:\n          persist-credentials: false',
    );
    expect(checkWorkflow(t).join()).toMatch(/persist-credentials/);
  });
});

describe('real workflows', () => {
  const dir = join(import.meta.dirname, '..', '.github', 'workflows');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yml')) : [];

  it('has at least one workflow in .github/workflows/', () => {
    expect(files.length, `no .github/workflows/*.yml found in ${dir}`).toBeGreaterThan(0);
  });

  it.each(files)('%s satisfies the policy', (f) => {
    expect(checkWorkflow(readFileSync(join(dir, f), 'utf8'))).toEqual([]);
  });
});

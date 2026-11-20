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

const STUB = `#!/bin/bash
case "$*" in
  *collaborators*) echo "\${ROLE:-admin}" ;;
  *branches/main*) [ "\${NO_MAIN:-}" = 1 ] && exit 1; echo maintip ;;
  *compare/maintip...head*) [ "\${NO_COMPARE:-}" = 1 ] && exit 1; cat "$ROWS_FILE" ;;
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

const tsv = (files: string[]): string => files.map((f) => `${f}\t\n`).join('');
const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `docs/page-${String(i).padStart(4, '0')}.md`);

function run(files: string[], env: Record<string, string> = {}): { posted: boolean; refused: string; labelDeleted: boolean } {
  writeFileSync(join(dir, 'rows'), tsv(files));
  writeFileSync(join(dir, 'log'), '');
  writeFileSync(join(dir, 'summary'), '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      REPO: 'o/r', PR: '1', LABEL: 'skip-confidence', SENDER: 'me', SENDER_TYPE: 'User', HEAD_SHA: 'head',
      ROWS_FILE: join(dir, 'rows'), LOG: join(dir, 'log'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
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
  // The compare endpoint returns 300 files on page 1 and nothing after, sorted by path: a gate file can sit past the cut.
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
  it('an empty file list is refused', () => {
    expect(run([]).posted).toBe(false);
  });
});

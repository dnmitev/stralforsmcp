import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DAY = 86_400_000;
const SECTIONS = new Set(['vulnerabilities', 'misconfigurations']);

// ponytail: line-based, not a YAML parser; entries are block-style `- id:` items.
export function checkTrivyIgnore(text: string, today: Date): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  const day0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  let section = '';
  let entry: { id: string; lines: string[] } | undefined;
  const flush = (): void => {
    if (!entry) return;
    const body = entry.lines.join('\n');
    const label = `entry ${entry.id} :`;
    if (!/^\s*statement:[ \t]*\S/m.test(body)) out.push(`${label} missing statement`);
    const m = /^\s*expired_at:\s*(\d{4})-(\d{2})-(\d{2})\s*$/m.exec(body);
    if (!m) out.push(`${label} missing expired_at`);
    else {
      const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (t < day0) out.push(`${label} expired`);
      else if (t > day0 + 90 * DAY) out.push(`${label} more than 90 days ahead`);
    }
    entry = undefined;
  };
  for (const l of lines) {
    if (l.trim().startsWith('#')) continue;
    const key = /^([A-Za-z_]+):/.exec(l);
    if (key) {
      flush();
      section = key[1] ?? '';
      continue;
    }
    const id = /^\s*- id:\s*(\S+)/.exec(l);
    if (id) {
      flush();
      if (!SECTIONS.has(section)) out.push(`- id: ${id[1]} outside vulnerabilities/misconfigurations`);
      entry = { id: id[1] ?? '', lines: [] };
    } else entry?.lines.push(l);
  }
  flush();
  return out;
}

const today = new Date('2026-11-12T10:00:00Z');
const plus = (d: number): string => new Date(today.getTime() + d * DAY).toISOString().slice(0, 10);
const entry = (extra: string): string =>
  `vulnerabilities:\n  - id: CVE-2099-0001\n${extra}\nmisconfigurations: []\n`;

describe('checkTrivyIgnore fixtures', () => {
  it('empty lists are valid', () => {
    expect(checkTrivyIgnore('vulnerabilities: []\nmisconfigurations: []\n', today)).toEqual([]);
  });
  it('valid entry 30 days ahead', () => {
    expect(checkTrivyIgnore(entry(`    statement: waiting for upstream fix, TRK-1\n    expired_at: ${plus(30)}`), today)).toEqual([]);
  });
  it('today and today+90 are accepted', () => {
    for (const d of [0, 90])
      expect(checkTrivyIgnore(entry(`    statement: x\n    expired_at: ${plus(d)}`), today)).toEqual([]);
  });
  it('missing expired_at', () => {
    expect(checkTrivyIgnore(entry('    statement: x'), today)).toEqual([
      'entry CVE-2099-0001 : missing expired_at',
    ]);
  });
  it('yesterday is expired', () => {
    expect(checkTrivyIgnore(entry(`    statement: x\n    expired_at: ${plus(-1)}`), today).join()).toMatch(/expired/);
  });
  it('91 days ahead is too far', () => {
    expect(checkTrivyIgnore(entry(`    statement: x\n    expired_at: ${plus(91)}`), today).join()).toMatch(
      /more than 90 days/,
    );
  });
  it('missing or empty statement', () => {
    expect(checkTrivyIgnore(entry(`    expired_at: ${plus(5)}`), today).join()).toMatch(/missing statement/);
    expect(checkTrivyIgnore(entry(`    statement:\n    expired_at: ${plus(5)}`), today).join()).toMatch(/missing statement/);
  });
  it('malformed date is missing', () => {
    expect(checkTrivyIgnore(entry(`    statement: x\n    expired_at: soon`), today).join()).toMatch(/missing expired_at/);
  });
  it('each entry is judged separately', () => {
    const t = `vulnerabilities:\n  - id: A\n    statement: x\n    expired_at: ${plus(5)}\n  - id: B\n    statement: x\n`;
    expect(checkTrivyIgnore(t, today)).toEqual(['entry B : missing expired_at']);
  });
  it('an id outside the two sections is an error', () => {
    expect(checkTrivyIgnore(`other:\n  - id: X\n    statement: s\n    expired_at: ${plus(5)}\n`, today).join()).toMatch(
      /outside/,
    );
  });
  it('comments are ignored', () => {
    expect(checkTrivyIgnore('# - id: CVE-1\nvulnerabilities: []\n', today)).toEqual([]);
  });
});

describe('real .trivyignore.yaml', () => {
  const file = join(import.meta.dirname, '..', '.trivyignore.yaml');
  it('exists and passes the entry policy (statement, expiry within 90 days)', () => {
    expect(existsSync(file), '.trivyignore.yaml missing').toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(checkTrivyIgnore(text, new Date())).toEqual([]);
  });
});

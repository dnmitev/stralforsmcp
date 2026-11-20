import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bundledPackageDirs, buildNotices } from './mcpb-notices.ts';

const root = mkdtempSync(join(tmpdir(), 'notices-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const pkg = (dir: string, json: object, files: Record<string, string> = {}) => {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'package.json'), JSON.stringify(json));
  for (const [n, t] of Object.entries(files)) writeFileSync(join(d, n), t);
};

pkg('node_modules/zeta', { name: 'zeta', version: '1.0.0', license: 'MIT' }, { LICENSE: 'Zeta licence text' });
pkg('node_modules/@scope/alpha', { name: '@scope/alpha', version: '2.1.0', license: 'Apache-2.0' }, { LICENSE: 'Alpha licence', NOTICE: 'Alpha notice' });
pkg('node_modules/zeta/node_modules/nested', { name: 'nested', version: '0.3.0', license: 'ISC' }, { 'LICENSE.md': 'Nested licence' });
pkg('node_modules/nolicence', { name: 'nolicence', version: '1.0.0', license: 'MIT' });
pkg('node_modules/blank', { name: 'blank', version: '1.0.0', license: 'MIT' }, { LICENSE: '  \n\n' });
pkg('node_modules/noticeonly', { name: 'noticeonly', version: '1.0.0', license: 'MIT' }, { LICENSE: ' \n', NOTICE: 'Copyright (c) Someone' });
pkg('node_modules/nofield', { name: 'nofield', version: '1.0.0' }, { LICENSE: 'text' });

describe('bundledPackageDirs', () => {
  it('maps metafile inputs to unique package directories, scoped and nested, and ignores own code', () => {
    const dirs = bundledPackageDirs(
      [
        'extension/src/proxy.ts',
        'src/server/x.ts',
        'node_modules/zeta/index.js',
        'node_modules/zeta/lib/deep/file.js',
        'node_modules/@scope/alpha/dist/a.js',
        'node_modules/zeta/node_modules/nested/i.js',
      ],
      root,
    );
    expect(dirs).toEqual([
      join(root, 'node_modules/@scope/alpha'),
      join(root, 'node_modules/zeta'),
      join(root, 'node_modules/zeta/node_modules/nested'),
    ]);
  });
});

describe('buildNotices', () => {
  const dirs = [join(root, 'node_modules/zeta'), join(root, 'node_modules/@scope/alpha'), join(root, 'node_modules/zeta/node_modules/nested')];
  it('lists name, version, licence and every licence/notice file, sorted by name', () => {
    const t = buildNotices(dirs);
    expect(t.indexOf('@scope/alpha 2.1.0')).toBeLessThan(t.indexOf('nested 0.3.0'));
    expect(t.indexOf('nested 0.3.0')).toBeLessThan(t.indexOf('zeta 1.0.0'));
    expect(t).toContain('License: Apache-2.0');
    expect(t).toContain('Alpha licence');
    expect(t).toContain('Alpha notice');
    expect(t).toContain('Nested licence');
    expect(t).toContain('Zeta licence text');
  });
  it('is byte-identical for the same input in any order', () => {
    expect(buildNotices([...dirs].reverse())).toBe(buildNotices(dirs));
  });
  it('fails when a bundled package has no licence text', () => {
    expect(() => buildNotices([join(root, 'node_modules/nolicence')])).toThrow(/nolicence.*licen[cs]e text/i);
  });
  it('fails when the only licence file is empty or whitespace', () => {
    expect(() => buildNotices([join(root, 'node_modules/blank')])).toThrow(/blank.*licen[cs]e text/i);
  });
  it('fails when only a NOTICE has text: a notice is not the licence text', () => {
    expect(() => buildNotices([join(root, 'node_modules/noticeonly')])).toThrow(/noticeonly.*licen[cs]e text/i);
  });
  it('fails when a package has only a NOTICE file and no licence file', () => {
    pkg('node_modules/noticefile', { name: 'noticefile', version: '1.0.0', license: 'Apache-2.0' }, { NOTICE: 'Copyright (c) Someone' });
    expect(() => buildNotices([join(root, 'node_modules/noticefile')])).toThrow(/noticefile.*licen[cs]e text/i);
  });
  it('fails when a bundled package declares no licence', () => {
    expect(() => buildNotices([join(root, 'node_modules/nofield')])).toThrow(/nofield.*license field/i);
  });
});

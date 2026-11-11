/* R25 follow-ups: serverInfo module, no import cycle, one text helper. */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as index from '../index.ts';
import { serverInfo } from '../server-info.ts';
import { text } from './guards.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
const source = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

/** Runtime (non type-only) relative imports of a source file, as absolute paths. */
const imports = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/^(?:import|export)(?!\s+type\b)[^'"\n]*?from\s+'(\.[^']+)'|import\('(\.[^']+)'\)/gm)].map((m) => resolve(dirname(file), (m[1] ?? m[2])!));
const reachable = (from: string): Set<string> => {
  const seen = new Set<string>();
  const walk = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const i of imports(f)) walk(i);
  };
  walk(from);
  return seen;
};

describe('serverInfo module', () => {
  it('carries name and version from package.json and is re-exported by the index', () => {
    expect(serverInfo).toEqual({ name: pkg.name, version: pkg.version });
    expect(index.serverInfo).toBe(serverInfo);
  });
});

describe('no ESM cycle through the index', () => {
  it('no module under src/server or src/stralfors imports ../index.ts', () => {
    for (const dir of ['server', 'stralfors']) {
      for (const f of readdirSync(resolve(root, dir)).filter((n) => n.endsWith('.ts') && !n.includes('.test.'))) {
        expect(source(`${dir}/${f}`), `${dir}/${f}`).not.toMatch(/from '\.\.\/index\.ts'/);
      }
    }
  });

  it.each(['server/mcp.ts', 'stralfors/index.ts', 'server/main.ts'])('src/index.ts is not reachable from %s', (entry) => {
    expect(reachable(resolve(root, entry)).has(resolve(root, 'index.ts'))).toBe(false);
  });
});

describe('one text helper', () => {
  it('guards.text builds the plain-text response; http.ts no longer defines plain', () => {
    expect(text(404, 'not found')).toEqual({ status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'not found' });
    expect(text(429, 'x', { 'Retry-After': '3' })).toEqual({ status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '3' }, body: 'x' });
    expect(source('server/http.ts')).not.toMatch(/const plain\b/);
  });
});

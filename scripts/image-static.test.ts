import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (f: string): string => readFileSync(join(root, f), 'utf8');

/** Instructions with comments dropped and backslash continuations joined. */
function instructions(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of text.split(/\r?\n/)) {
    if (!cur && (raw.trim() === '' || raw.trim().startsWith('#'))) continue;
    const l = raw.trimEnd();
    if (l.endsWith('\\')) cur += `${l.slice(0, -1)} `;
    else {
      out.push((cur + l).replace(/\s+/g, ' ').trim());
      cur = '';
    }
  }
  return out;
}

describe('Dockerfile', () => {
  const ins = instructions(read('Dockerfile'));
  const froms = ins.flatMap((l, i) => (l.startsWith('FROM ') ? [i] : []));
  const final = ins.slice(froms[1] ?? 0);
  const build = ins.slice(froms[0] ?? 0, froms[1]);

  it('two digest-pinned FROM lines: node build stage, distroless nonroot final', () => {
    expect(froms).toHaveLength(2);
    expect(ins[froms[0] ?? 0]).toMatch(
      /^FROM --platform=\$BUILDPLATFORM node:26-trixie-slim@sha256:[0-9a-f]{64} AS deps$/,
    );
    expect(ins[froms[1] ?? 0]).toMatch(
      /^FROM gcr\.io\/distroless\/nodejs26-debian13:nonroot@sha256:[0-9a-f]{64}$/,
    );
  });

  it('build stage installs prod deps without scripts; no npm install anywhere', () => {
    expect(build.join('\n')).toMatch(/npm ci --omit=dev --ignore-scripts/);
    expect(ins.join('\n')).not.toMatch(/npm install/);
  });

  it('final stage: non-root user, workdir, ports, CMD in JSON form, no RUN, no HEALTHCHECK', () => {
    expect(final).toContain('USER 65532:65532');
    expect(final).toContain('WORKDIR /app');
    expect(final).toContain('EXPOSE 3000 9464');
    expect(final).toContain('CMD ["src/server/main.ts"]');
    expect(final.some((l) => l.startsWith('RUN '))).toBe(false);
    expect(ins.some((l) => l.startsWith('HEALTHCHECK'))).toBe(false);
    expect(ins.filter((l) => l.startsWith('CMD ') || l.startsWith('ENTRYPOINT '))).toEqual(['CMD ["src/server/main.ts"]']);
  });

  it('copies only package.json, src and prod node_modules into the final stage', () => {
    const copies = final.filter((l) => l.startsWith('COPY '));
    expect(copies.join('\n')).not.toMatch(/package-lock\.json/);
    expect(copies.every((l) => l.includes('--chown=65532:65532'))).toBe(true);
    expect(ins.some((l) => /^(COPY|ADD) (--\S+ )*\. /.test(l))).toBe(false);
    expect(ins.filter((l) => /^(COPY|ADD) /.test(l)).join('\n')).not.toMatch(/\.git|\.paul|docs|scripts|CLAUDE/);
    expect(copies.map((l) => l.split(' ').slice(-2).join(' ')).sort()).toEqual(
      ['/app/node_modules ./node_modules', 'package.json ./', 'src ./src'].sort(),
    );
  });

  it('only ENV is NODE_ENV=production; nothing secret-like in ARG/ENV/LABEL', () => {
    const envs = ins.filter((l) => l.startsWith('ENV '));
    expect(envs.length).toBeGreaterThan(0);
    expect(envs.every((l) => l === 'ENV NODE_ENV=production')).toBe(true);
    for (const l of ins.filter((x) => /^(ARG|ENV|LABEL) /.test(x))) expect(l).not.toMatch(/STRALFORS|MCP_|TOKEN|SECRET|KEY/);
  });

  it('OCI labels', () => {
    const labels = ins.filter((l) => l.startsWith('LABEL ')).join(' ');
    expect(labels).toContain('org.opencontainers.image.source="https://github.com/dnmitev/stralforsmcp"');
    expect(labels).toContain('org.opencontainers.image.licenses="Apache-2.0"');
    expect(labels).toContain('org.opencontainers.image.title="stralforsmcp"');
    expect(labels).toContain('org.opencontainers.image.version="${VERSION}"');
    expect(labels).toContain('org.opencontainers.image.revision="${REVISION}"');
    expect(ins).toContain('ARG VERSION=0.0.0');
    expect(ins).toContain('ARG REVISION=unknown');
  });

  it('no floating latest tag', () => {
    expect(ins.join('\n')).not.toMatch(/:latest\b/);
  });
});

describe('.dockerignore', () => {
  const lines = read('.dockerignore')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  it('is an allow-list: * first, exactly three re-includes', () => {
    expect(lines[0]).toBe('*');
    expect(lines.filter((l) => l.startsWith('!'))).toEqual(['!package.json', '!package-lock.json', '!src/**']);
  });
  it('re-excludes tests after the src allow-entry', () => {
    expect(lines.indexOf('src/**/*.test.ts')).toBeGreaterThan(lines.indexOf('!src/**'));
    expect(lines.indexOf('src/**/*.md')).toBeGreaterThan(lines.indexOf('!src/**'));
  });
});

describe('package.json', () => {
  it('engines.node is tightened to >=24.12', () => {
    expect(JSON.parse(read('package.json')).engines.node).toBe('>=24.12');
  });
});

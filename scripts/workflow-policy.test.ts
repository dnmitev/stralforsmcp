import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHA = 'a'.repeat(40);
const UNTRUSTED =
  /\$\{\{[^}]*(github\.event\.pull_request\.(title|body|head\.ref)|github\.head_ref|github\.base_ref|github\.event\.comment\.|github\.event\.issue\.)[^}]*\}\}/;
const REF_FIELDS = /\$\{\{[^}]*(github\.ref_name|github\.ref\b|github\.event\.ref\b)[^}]*\}\}/;
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
  checkImageRules(lines, out);
  return out;
}

// Rules for publishing workflows: packages: write, registry login and push: true only in a job that is
// gated to push events; no privileged permissions at top level; ref names never in run: of tag-triggered workflows.
function checkImageRules(lines: string[], out: string[]): void {
  const msg = (i: number, m: string): number => out.push(`line ${i + 1}: ${m}`);
  const jobsAt = lines.findIndex((l) => l.startsWith('jobs:'));
  const head = jobsAt < 0 ? lines : lines.slice(0, jobsAt);

  head.forEach((l, i) => {
    if (/^\s*packages:\s*(?!read\b|none\b)\w+/.test(l) || /packages:\s*(?!read\b|none\b)\w+/.test(l) && /^\s*permissions:/.test(l))
      msg(i, 'top-level packages: write');
  });
  const topPerm = head.findIndex((l) => l.startsWith('permissions:'));
  if (topPerm >= 0) {
    for (let j = topPerm; j < head.length; j++) {
      const l = head[j] ?? '';
      if (j > topPerm && l.trim() !== '' && indentOf(l) === 0 && !l.trim().startsWith('#')) break;
      if (/\b(id-token|attestations)\s*:\s*write|\bcontents:\s*write|\bpull-requests:\s*write/.test(l))
        msg(j, 'privileged permission at top level');
    }
  }

  if (jobsAt < 0) return;
  const starts: number[] = [];
  for (let i = jobsAt + 1; i < lines.length; i++) if (/^ {2}[\w-]+:\s*(#.*)?$/.test(lines[i] ?? '')) starts.push(i);
  starts.forEach((s, k) => {
    const end = starts[k + 1] ?? lines.length;
    const job = lines.slice(s, end);
    const text = job.join('\n');
    // ponytail: any `||` in the job-level if: counts as ungated; no boolean parsing.
    const gateLine = /^ {4}if:.*github\.event_name == 'push'.*$/m.exec(text)?.[0] ?? '';
    const gated = gateLine !== '' && !gateLine.includes('||');
    const writesPkg = /\bpackages:\s*write\b/.test(text);
    const name = (lines[s] ?? '').trim();
    if (writesPkg && !gated) msg(s, `job ${name} has packages: write without push gate`);
    const okJob = writesPkg && gated;
    job.forEach((l, j) => {
      if (l.trim().startsWith('#')) return;
      if (!okJob && /uses:\s*docker\/login-action@/.test(l))
        msg(s + j, 'login in a job without packages: write / push gate');
    });
    if (!okJob && /docker\/build-push-action@/.test(text) && /\bpush:\s*true\b/.test(text))
      msg(s, `job ${name}: push: true without packages: write / push gate`);
  });

  if (/^\s+tags:/m.test(head.join('\n'))) {
    lines.forEach((l, i) => {
      const r = /^(\s*)(- )?run:\s*(.*)$/.exec(l);
      if (!r) return;
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
      if (REF_FIELDS.test(body.join('\n'))) msg(i, 'ref name interpolated in run: (tag-triggered workflow; use env:)');
    });
  }
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
    'github.base_ref',
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


// ---- image / publish rules ------------------------------------------------------------------

const pub = `name: image
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
    tags: ['v*']
permissions:
  contents: read
jobs:
  build-scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${SHA} # v7.0.1
        with: { persist-credentials: false }
      - uses: docker/build-push-action@${SHA} # v7.4.0
        with: { context: ., push: false, load: true }
  publish:
    needs: build-scan
    if: github.event_name == 'push' && !github.event.repository.fork
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@${SHA} # v7.0.1
        with: { persist-credentials: false }
      - uses: docker/login-action@${SHA} # v4.8.0
        with: { registry: ghcr.io, username: x, password: y }
      - uses: docker/build-push-action@${SHA} # v7.4.0
        with:
          context: .
          push: true
      - name: Digest
        env: { DIGEST: z }
        run: echo "$DIGEST" >> "$GITHUB_STEP_SUMMARY"
`;
const mut = (a: string, b: string, text = pub): string => {
  expect(text).toContain(a);
  return text.replace(a, b);
};

describe('checkWorkflow: image rules (fixtures)', () => {
  it('passes a clean publishing workflow', () => {
    expect(checkWorkflow(pub)).toEqual([]);
  });
  it('flags packages: write at top level', () => {
    expect(checkWorkflow(mut('permissions:\n  contents: read\njobs', 'permissions:\n  contents: read\n  packages: write\njobs')).join()).toMatch(
      /top-level packages: write/,
    );
  });
  it('flags packages: write in a job without the push gate', () => {
    expect(
      checkWorkflow(mut("    if: github.event_name == 'push' && !github.event.repository.fork\n", '')).join(),
    ).toMatch(/push gate/);
  });
  it('a step-level if: does not satisfy the job push gate', () => {
    const t = mut(
      '      - uses: docker/login-action@' + SHA + ' # v4.8.0\n',
      '      - uses: docker/login-action@' + SHA + " # v4.8.0\n        if: github.event_name == 'push'\n",
    ).replace("    if: github.event_name == 'push' && !github.event.repository.fork\n", '');
    expect(checkWorkflow(t).join()).toMatch(/packages: write without push gate/);
  });
  it('a push gate on a different job does not count', () => {
    const t = mut(
      '    permissions:\n      contents: read\n    steps:',
      "    if: github.event_name == 'push'\n    permissions:\n      contents: read\n    steps:",
    ).replace("    if: github.event_name == 'push' && !github.event.repository.fork\n", '');
    expect(checkWorkflow(t).join()).toMatch(/push gate/);
  });
  it('flags docker/login-action outside the gated job', () => {
    const t = mut(
      '      - uses: docker/build-push-action@' + SHA + ' # v7.4.0\n        with: { context: ., push: false, load: true }',
      `      - uses: docker/login-action@${SHA} # v4.8.0`,
    );
    expect(checkWorkflow(t).join()).toMatch(/login in a job without packages: write \/ push gate/);
  });
  it('flags push: true outside the gated job', () => {
    expect(checkWorkflow(mut('push: false', 'push: true')).join()).toMatch(/push: true/);
  });
  it.each(['id-token: write', 'attestations: write', 'contents: write', 'pull-requests: write'])(
    'flags %s at top level but allows it in a job',
    (p) => {
      expect(checkWorkflow(mut('permissions:\n  contents: read\njobs', `permissions:\n  contents: read\n  ${p}\njobs`)).join()).toMatch(
        /top level/,
      );
      expect(
        checkWorkflow(mut('    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@' + SHA + ' # v7.0.1\n        with: { persist-credentials: false }\n      - uses: docker/build-push-action', `    permissions:\n      contents: read\n      ${p}\n    steps:\n      - uses: actions/checkout@${SHA} # v7.0.1\n        with: { persist-credentials: false }\n      - uses: docker/build-push-action`)),
      ).toEqual([]);
    },
  );
  it('a job-level if: that also admits pull requests (||) is not a push gate', () => {
    const t = mut(
      "if: github.event_name == 'push' && !github.event.repository.fork",
      "if: github.event_name == 'push' || github.event_name == 'pull_request'",
    );
    expect(checkWorkflow(t).join()).toMatch(/push gate/);
  });
  it.each(['github.ref_name', 'github.ref', 'github.event.ref'])('flags %s in run: of a tag-triggered workflow', (e) => {
    expect(checkWorkflow(mut('run: echo "$DIGEST"', `run: echo "\${{ ${e} }}"`)).join()).toMatch(/run:/);
  });
  it('allows github.ref in with:/concurrency of a tag-triggered workflow', () => {
    expect(
      checkWorkflow(mut('permissions:\n  contents: read\njobs', "concurrency:\n  group: image-${{ github.ref }}\npermissions:\n  contents: read\njobs")),
    ).toEqual([]);
  });
  it('github.ref_name in run: is tolerated when the workflow has no tag filter', () => {
    const t = mut("    tags: ['v*']\n", '').replace('run: echo "$DIGEST"', 'run: echo "${{ github.ref_name }}"');
    expect(checkWorkflow(t)).toEqual([]);
  });
});

describe('image.yml (real file)', () => {
  const dir = join(import.meta.dirname, '..', '.github', 'workflows');
  const path = join(dir, 'image.yml');
  const real = existsSync(path) ? readFileSync(path, 'utf8') : '';

  it('exists and passes the policy, as does ci.yml', () => {
    expect(existsSync(path), '.github/workflows/image.yml missing').toBe(true);
    expect(checkWorkflow(real)).toEqual([]);
    expect(checkWorkflow(readFileSync(join(dir, 'ci.yml'), 'utf8'))).toEqual([]);
  });

  it('mutation: unpinning one action is reported as not pinned', () => {
    const m = real.replace(/@[0-9a-f]{40}/, '@v7');
    expect(m).not.toBe(real);
    expect(checkWorkflow(real)).toEqual([]);
    expect(checkWorkflow(m).join()).toMatch(/not pinned/);
  });
  it('mutation: packages: write at top level', () => {
    const m = real.replace(/^permissions:\n {2}contents: read\n/m, 'permissions:\n  contents: read\n  packages: write\n');
    expect(m).not.toBe(real);
    expect(checkWorkflow(m).join()).toMatch(/top-level packages/);
  });
  it('mutation: dropping the push gate of publish', () => {
    const m = real.replace(/^\s*if:.*github\.event_name == 'push'.*\n/m, '');
    expect(m).not.toBe(real);
    expect(checkWorkflow(m).join()).toMatch(/push gate/);
  });
  it('mutation: github.ref_name in run:', () => {
    const m = real.replace(/^( {4}steps:\n)/m, '$1      - run: echo ${{ github.ref_name }}\n');
    expect(m).not.toBe(real);
    expect(checkWorkflow(m).join()).toMatch(/run:/);
  });

  describe('shape (R38/R39)', () => {
    const job = (name: string): string => {
      const m = new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}[\\w-]+:\\n|$(?![\\s\\S]))`, 'm').exec(real);
      return m?.[1] ?? '';
    };
    it('triggers are only pull_request and push; no paths filter, dispatch, schedule or workflow_run', () => {
      const on = /^on:\n([\s\S]*?)^\S/m.exec(real)?.[1] ?? '';
      expect([...on.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])).toEqual(['pull_request', 'push']);
      expect(real).not.toMatch(/workflow_dispatch|schedule:|workflow_run|^\s*paths:/m);
      expect(on).toMatch(/tags:\s*\['v\*'\]/);
    });
    it('build-scan: read-only, no secrets, no login, no push', () => {
      const b = job('build-scan');
      expect(b).toMatch(/permissions:\n\s+contents: read\n/);
      expect(b).not.toMatch(/secrets\.|login-action|packages:|push:\s*true/);
      expect(b).toMatch(/push:\s*false/);
      expect(b).toMatch(/load:\s*true/);
      expect(b).toContain('bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf');
      expect(b).toContain('sha256sum -c');
      expect(b).toContain('--exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed');
    });
    it('trivy is a pinned binary, not the action; no QEMU; no cosign', () => {
      expect(real).not.toMatch(/aquasecurity\/trivy-action|setup-qemu-action|cosign/);
    });
    it('publish: gated, needs build-scan, GITHUB_TOKEN only, packages: write exactly once', () => {
      const p = job('publish');
      expect(p).toMatch(/needs: build-scan/);
      expect(p).toMatch(/if:.*github\.event_name == 'push'/);
      expect(p).toMatch(/github\.event\.repository\.fork/);
      expect(real.match(/packages:\s*write/g)).toHaveLength(1);
      expect(p).toMatch(/packages: write/);
      expect([...real.matchAll(/secrets\.(\w+)/g)].map((m) => m[1])).toEqual(['GITHUB_TOKEN']);
      expect(real).not.toMatch(/id-token|attestations|contents:\s*write/);
      expect(p).toMatch(/platforms:\s*linux\/amd64,linux\/arm64/);
      expect(p).toMatch(/provenance:\s*mode=max/);
      expect(p).toMatch(/sbom:\s*true/);
    });
    it('tag policy lines are exactly the five from the design', () => {
      expect(real).toMatch(/flavor:\s*latest=false/);
      for (const t of [
        'type=sha,format=long',
        'type=edge,branch=main',
        'type=semver,pattern={{version}}',
        'type=semver,pattern={{major}}.{{minor}}',
        "type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v') }}",
      ])
        expect(real).toContain(t);
      expect(real.match(/^\s+type=/gm)).toHaveLength(5);
    });
  });
});

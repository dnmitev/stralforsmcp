import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];

  it('has at least one workflow in .github/workflows/', () => {
    expect(files.length, `no .github/workflows/*.yml found in ${dir}`).toBeGreaterThan(0);
  });

  it.each(files)('%s satisfies the policy', (f) => {
    expect(checkWorkflow(readFileSync(join(dir, f), 'utf8'))).toEqual([]);
  });

  // M2: a cancelled push run on main leaves no green CI and no Stryker baseline. Only pull_request runs may be cancelled.
  it.each(files)('%s cancels in-progress runs only for pull_request events', (f) => {
    const m = /^\s*cancel-in-progress:\s*(.+?)\s*$/m.exec(readFileSync(join(dir, f), 'utf8'));
    if (!m) return;
    expect(m[1]).toMatch(/^(false|\$\{\{\s*github\.event_name == 'pull_request'\s*\}\})$/);
  });

  it('ci.yml uses exactly the pull_request expression', () => {
    expect(readFileSync(join(dir, 'ci.yml'), 'utf8')).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
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
    it('trivy is a pinned binary, not the action; no QEMU; cosign is not an action either', () => {
      expect(real).not.toMatch(/aquasecurity\/trivy-action|setup-qemu-action|sigstore\/cosign-installer/);
    });
    it('publish: gated, needs build-scan, GITHUB_TOKEN only, packages: write exactly once', () => {
      const p = job('publish');
      expect(p).toMatch(/needs: build-scan/);
      expect(p).toMatch(/if:.*github\.event_name == 'push'/);
      expect(p).toMatch(/github\.event\.repository\.fork/);
      expect(real.match(/packages:\s*write/g)).toHaveLength(1);
      expect(p).toMatch(/packages: write/);
      expect([...real.matchAll(/secrets\.(\w+)/g)].map((m) => m[1])).toEqual(['GITHUB_TOKEN']);
      expect(p).toMatch(/platforms:\s*linux\/amd64,linux\/arm64/);
      expect(p).toMatch(/provenance:\s*mode=max/);
      expect(p).toMatch(/sbom:\s*true/);
    });
    it('tag policy lines are exactly the four from the design; latest only through flavor auto', () => {
      expect(real).toMatch(/flavor:\s*latest=auto/);
      expect(real).not.toMatch(/type=raw,value=latest/);
      expect(real).not.toMatch(/flavor:\s*latest=(true|false)/);
      for (const t of [
        'type=sha,format=long',
        'type=edge,branch=main',
        'type=semver,pattern={{version}}',
        'type=semver,pattern={{major}}.{{minor}}',
      ])
        expect(real).toContain(t);
      expect(real.match(/^\s+type=/gm)).toHaveLength(4);
    });
    // 05-03c (R-19): a bad tag must stop before anything is pushed. publish needs build-scan, which runs this first.
    it('checks the release tag in build-scan, before any build, from env, tags only', () => {
      const b = job('build-scan');
      expect(real).toMatch(/publish:[\s\S]*?needs: build-scan/);
      const step = /- name: Check release tag\n([\s\S]*?)(?=\n {6}- uses:)/.exec(b)?.[1] ?? '';
      expect(step).toMatch(/if: github\.ref_type == 'tag'/);
      expect(step).toMatch(/REF_NAME: \$\{\{ github\.ref_name \}\}/);
      expect(step).toMatch(/package\.json/);
      expect(b.indexOf('Check release tag')).toBeGreaterThan(b.indexOf('actions/checkout'));
      expect(b.indexOf('Check release tag')).toBeLessThan(b.indexOf('docker/build-push-action'));
    });
    it.each([
      ['v0.1.0', true],
      ['v1.2.3', true],
      ['v10.20.30', true],
      ['v1.2.3-rc.1', false], // prereleases are not published (main never carries a prerelease version)
      ['vnext', false],
      ['v1', false],
      ['v1.2', false],
      ['v01.2.3', false],
      ['v1.2.3+meta', false],
      ['v1.2.3-', false],
      ['v1.2.3-rc..1', false],
      ['v1.2.3-rc.', false],
      ['v1.2.3-01', false],
      ['v1.2.3-rc.01', false],
      ['v1.2.3-rc.0', false],
      ['v1.2.3-0a', false],
      ['v1.2.3-00', false],
      ['v1.2.3-rc-1.x-y', false],
      ['1.2.3', false],
      ['v1.2.3 ', false],
      ['v1.2.3\nx', false],
    ])('tag regex: %j -> %s', (tag, ok) => {
      const m = /re='(\^v[^']+\$)'/.exec(real);
      expect(m, 'tag regex line missing').not.toBeNull();
      expect(new RegExp(m?.[1] ?? '').test(tag)).toBe(ok);
    });
  });
});

// ---- 05-03b: mcpb, signing, rescan, dependabot, denylist ---------------------------------------

const wfDir = join(import.meta.dirname, '..', '.github', 'workflows');
const wf = (name: string): string => readFileSync(join(wfDir, name), 'utf8');
const jobOf = (text: string, name: string): string => {
  const m = new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}[\\w-]+:\\n|$(?![\\s\\S]))`, 'm').exec(text);
  return (m?.[1] ?? '').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
};

/** R-18 rules for image.yml: cosign is a pinned binary, id-token only in publish, the pushed digest is scanned before it is signed. */
export function signingProblems(text: string): string[] {
  const out: string[] = [];
  const job = (name: string): string => (new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}[\\w-]+:\\n|$(?![\\s\\S]))`, 'm').exec(text)?.[1] ?? '');
  const p = job('publish');
  const b = job('build-scan');
  // parsed, so a commented-out permission does not count
  const jobs = ((parse(text) as { jobs?: Record<string, { permissions?: Record<string, string> }> }).jobs ?? {});
  const idJobs = Object.entries(jobs).filter(([, j]) => j.permissions?.['id-token'] === 'write').map(([n]) => n);
  if (idJobs.length !== 1 || idJobs[0] !== 'publish') out.push(`id-token: write must be granted to publish only (found: ${idJobs.join(',') || 'none'})`);
  if (/id-token|cosign/.test(b)) out.push('build-scan must not sign or hold id-token');
  if (/attestations|contents:\s*write/.test(text)) out.push('attestations or contents: write present');
  if (/sigstore\/cosign-installer/.test(text)) out.push('cosign must be a pinned binary, not an action');
  const install = /- name: Install cosign[\s\S]*?(?=\n {6}- name:)/.exec(p)?.[0] ?? '';
  if (!/cosign-linux-amd64/.test(install) || !/[0-9a-f]{64}\s+\S*cosign[\s\S]*sha256sum -c/.test(install)) out.push('cosign binary is not pinned by sha256');
  const scan = p.indexOf('--platform "$p"');
  const sign = p.indexOf('cosign" sign');
  if (scan < 0) out.push('pushed digest is not scanned');
  if (sign < 0) out.push('image is not signed');
  if (scan >= 0 && sign >= 0 && sign < scan) out.push('signature comes before the scan of the pushed digest');
  if (!/linux\/amd64 linux\/arm64/.test(p) || !p.includes('--exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed')) out.push('scan gate must cover both platforms with the HIGH/CRITICAL gate');
  if (!/image="ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}@\$\{DIGEST\}"/.test(p) || !/cosign" sign --yes "ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}@\$\{DIGEST\}"/.test(p)) out.push('scan and signature must use the pushed digest');
  return out;
}

describe('signing rules (R-18)', () => {
  const real = wf('image.yml');
  it('the real image.yml has none', () => expect(signingProblems(real)).toEqual([]));
  it('mutation: the id-token permission is commented out (a comment is not a permission)', () => {
    expect(signingProblems(real.replace('      id-token: write # keyless', '      # id-token: write # keyless')).join()).toMatch(/id-token: write must/);
  });
  it('mutation: id-token granted to a second job', () => {
    expect(signingProblems(real.replace('    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    permissions:\n      contents: read\n', '    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    permissions:\n      contents: read\n      id-token: write\n')).join()).toMatch(/id-token: write must be granted to publish only \(found: [^)]*build-scan/);
  });
  it('mutation: unpinned cosign (no checksum)', () => {
    expect(signingProblems(real.replace(/ \| sha256sum -c -\n( +)chmod \+x/, '\n$1chmod +x')).join()).toMatch(/pinned by sha256/);
  });
  it('mutation: cosign installed through an action', () => {
    expect(signingProblems(real + '\n      - uses: sigstore/cosign-installer@' + 'a'.repeat(40)).join()).toMatch(/not an action/);
  });
  it('mutation: id-token in build-scan', () => {
    expect(signingProblems(real.replace('  build-scan:\n    runs-on: ubuntu-latest', '  build-scan:\n    runs-on: ubuntu-latest\n    permissions-x: id-token')).join()).toMatch(/build-scan/);
  });
  it('mutation: signing before the scan', () => {
    const scanStep = /      - name: Scan the pushed digest[\s\S]*?(?=      - name: Install cosign)/.exec(real)?.[0] ?? '';
    expect(scanStep).not.toBe('');
    const moved = real.replace(scanStep, '').replace('      - name: Digest\n', scanStep + '      - name: Digest\n');
    expect(signingProblems(moved)).toEqual([]); // scan still first: sanity of the splice
    const signStep = /      - name: Sign the scanned digest[\s\S]*$/.exec(real)?.[0] ?? '';
    const swapped = real.replace(signStep, '').replace('      - name: Install trivy (pinned sha256)\n        run: |\n          f=trivy_0.76.2_Linux-64bit.tar.gz\n          curl -fsSL -o "$RUNNER_TEMP/$f" "https://github.com/aquasecurity/trivy/releases/download/v0.76.2/$f"\n          echo "bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf  $RUNNER_TEMP/$f" | sha256sum -c -\n          tar -xzf "$RUNNER_TEMP/$f" -C "$RUNNER_TEMP" trivy\n      - name: Scan the pushed', signStep + '      - name: Install trivy (pinned sha256)\n        run: |\n          f=trivy_0.76.2_Linux-64bit.tar.gz\n          curl -fsSL -o "$RUNNER_TEMP/$f" "https://github.com/aquasecurity/trivy/releases/download/v0.76.2/$f"\n          echo "bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf  $RUNNER_TEMP/$f" | sha256sum -c -\n          tar -xzf "$RUNNER_TEMP/$f" -C "$RUNNER_TEMP" trivy\n      - name: Scan the pushed');
    expect(signingProblems(swapped).join()).toMatch(/before the scan|not scanned|not signed/);
  });
  it('mutation: signing a tag instead of the digest', () => {
    expect(signingProblems(real.replace('cosign" sign --yes "ghcr.io/${GITHUB_REPOSITORY,,}@${DIGEST}"', 'cosign" sign --yes "ghcr.io/${GITHUB_REPOSITORY,,}:edge"')).join()).toMatch(/pushed digest/);
  });
});

describe('mcpb.yml (real file)', () => {
  const real = wf('mcpb.yml');
  it('triggers only on pull_request and push (main, v* tags); no dispatch, schedule or workflow_run', () => {
    const on = /^on:\n([\s\S]*?)^\S/m.exec(real)?.[1] ?? '';
    expect([...on.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])).toEqual(['pull_request', 'push']);
    expect(real).not.toMatch(/workflow_dispatch|schedule:|workflow_run/);
    expect(on).toMatch(/tags:\s*\['v\*'\]/);
  });
  it('build: read-only, no secrets, runs a clean npm ci, build, verify and checksum', () => {
    const b = jobOf(real, 'build');
    expect(b).toMatch(/permissions:\n\s+contents: read\n/);
    expect(b).not.toMatch(/id-token|attestations|secrets\./);
    for (const s of ['npm ci', 'npm run mcpb:build', 'node scripts/mcpb-verify.ts', 'sha256sum']) expect(b, s).toContain(s);
  });
  it('id-token and attestations: write appear exactly once, in the tag-gated attest job', () => {
    expect(real.match(/id-token:\s*write/g)).toHaveLength(1);
    expect(real.match(/attestations:\s*write/g)).toHaveLength(1);
    const a = jobOf(real, 'attest');
    expect(a).toMatch(/id-token:\s*write/);
    expect(a).toMatch(/attestations:\s*write/);
    expect(a).toMatch(/if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/);
    expect(a).toMatch(/github\.event\.repository\.fork/);
    expect(a).toMatch(/needs: build/);
    expect(a).toContain('actions/attest-build-provenance@');
    expect(real).not.toMatch(/contents:\s*write/);
  });
});

/** chart.yml: package on every event, push + sign only for a v* tag, never overwrite a published version. */
export function chartProblems(text: string): string[] {
  const out: string[] = [];
  const on = /^on:\n([\s\S]*?)^\S/m.exec(text)?.[1] ?? '';
  if ([...on.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]).join() !== 'pull_request,push') out.push('triggers must be pull_request and push only');
  if (/workflow_dispatch|schedule:|workflow_run|branches:\s*\[main\]\n\s+tags/.test(text) || !/push:\n\s+tags:\s*\['v\*'\]\n/.test(on)) out.push('push must be v* tags only');
  const jobs = ((parse(text) as { jobs?: Record<string, { permissions?: Record<string, string> }> }).jobs ?? {});
  const idJobs = Object.entries(jobs).filter(([, j]) => j.permissions?.['id-token'] === 'write').map(([n]) => n);
  if (idJobs.join() !== 'publish') out.push(`id-token: write must be granted to publish only (found: ${idJobs.join(',') || 'none'})`);
  const k = jobOf(text, 'package');
  const p = jobOf(text, 'publish');
  if (/secrets\.|id-token|packages:|registry login|helm" push|cosign/.test(k)) out.push('package must not log in, push or sign');
  if (!/if: github\.event_name == 'push' && github\.ref_type == 'tag' && !github\.event\.repository\.fork/.test(p)) out.push('publish must be gated to tag pushes, never forks');
  if (!/needs: package/.test(p)) out.push('publish must push the package job artifact');
  if (/attestations|contents:\s*write|sigstore\/cosign-installer|azure\/setup-helm/.test(text)) out.push('no write beyond packages, no installer actions');
  for (const [name, re] of [['helm', /helm-v[\d.]+-linux-amd64\.tar\.gz"?\n\s+curl[^\n]*\n\s+echo "[0-9a-f]{64}\s+\S+" \| sha256sum -c -/], ['cosign', /[0-9a-f]{64}\s+\S*cosign" \| sha256sum -c -/]] as const)
    if (!re.test(p)) out.push(`${name} binary is not pinned by sha256 in publish`);
  const exists = p.indexOf('helm" show chart');
  const push = p.indexOf('helm" push');
  const sign = p.indexOf('cosign" sign');
  if (exists < 0 || push < 0 || exists > push) out.push('the existence check must run before the push');
  if (!/if "\$RUNNER_TEMP\/helm" show chart[^\n]*\n[^\n]*\n\s+exit 1/.test(p)) out.push('an existing version must fail the run');
  if (sign < 0 || sign < push) out.push('the signature must follow the push');
  if (!/cosign" sign --yes "ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}\/charts\/stralforsmcp@\$\{DIGEST\}"/.test(p)) out.push('the signature must use the pushed digest');
  return out;
}

describe('chart.yml (real file)', () => {
  const real = wf('chart.yml');
  it('has no problems', () => expect(chartProblems(real)).toEqual([]));
  it.each([
    ['a main-branch push trigger', (t: string) => t.replace("  push:\n    tags: ['v*']", "  push:\n    branches: [main]\n    tags: ['v*']"), /v\* tags only/],
    ['id-token in package', (t: string) => t.replace('    timeout-minutes: 10\n    permissions:\n      contents: read\n    steps', '    timeout-minutes: 10\n    permissions:\n      contents: read\n      id-token: write\n    steps'), /publish only/],
    ['an ungated publish', (t: string) => t.replace(" && github.ref_type == 'tag'", ''), /gated/],
    ['no existence check', (t: string) => t.replace(/if "\$RUNNER_TEMP\/helm" show chart/, 'if false; then :; fi; if "$RUNNER_TEMP/helm" inspect chart'), /existence check/],
    ['an existing version only warns', (t: string) => t.replace(/release a new tag"\n\s+exit 1/, 'release a new tag"'), /must fail/],
    ['an unpinned cosign', (t: string) => t.replace(/echo "[0-9a-f]{64} {2}\$RUNNER_TEMP\/cosign" \| sha256sum -c -\n/, ''), /cosign binary/],
    ['signing a tag', (t: string) => t.replace('stralforsmcp@${DIGEST}"', 'stralforsmcp:latest"'), /pushed digest/],
  ])('mutation: %s', (_, m, re) => {
    const t = m(real);
    expect(t).not.toBe(real);
    expect(chartProblems(t).join()).toMatch(re);
  });
});

describe('rescan.yml (real file)', () => {
  const real = wf('rescan.yml');
  it('runs on a schedule and on demand only', () => {
    const on = /^on:\n([\s\S]*?)^\S/m.exec(real)?.[1] ?? '';
    expect([...on.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])).toEqual(['schedule', 'workflow_dispatch']);
    expect(on).toMatch(/cron:\s*'\d+ \d+ \* \* \d'/);
  });
  it('is read-only: packages: read, no write permission, no id-token, no secret but GITHUB_TOKEN', () => {
    expect(real).not.toMatch(/:\s*write\b/);
    expect(real).not.toMatch(/id-token|attestations/);
    expect(real).toMatch(/packages:\s*read/);
    expect([...real.matchAll(/secrets\.(\w+)/g)].map((m) => m[1])).toEqual(['GITHUB_TOKEN']);
  });
  it('scans the published edge image with the pinned trivy binary and the fixable HIGH/CRITICAL gate', () => {
    expect(real).toContain('bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf');
    expect(real).toContain('sha256sum -c');
    expect(real).toContain('--exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed');
    expect(real).toMatch(/ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}:edge/);
    expect(real).not.toMatch(/aquasecurity\/trivy-action/);
    expect(real).toMatch(/!github\.event\.repository\.fork/);
  });
});

describe('dependabot.yml', () => {
  const text = readFileSync(join(import.meta.dirname, '..', '.github', 'dependabot.yml'), 'utf8');
  const cfg = parse(text) as { version: number; updates: { 'package-ecosystem': string; directory: string; cooldown?: { 'default-days'?: number }; groups?: Record<string, { patterns?: string[] }>; 'open-pull-requests-limit'?: number }[] };
  it('covers npm, github-actions and docker at the repository root', () => {
    expect(cfg.version).toBe(2);
    expect(cfg.updates.map((u) => u['package-ecosystem']).sort()).toEqual(['docker', 'github-actions', 'npm']);
    for (const u of cfg.updates) expect(u.directory).toBe('/');
  });
  it('waits before adopting releases and keeps the open PR count low', () => {
    for (const u of cfg.updates) {
      expect(u.cooldown?.['default-days'], u['package-ecosystem']).toBeGreaterThanOrEqual(7);
      expect(u['open-pull-requests-limit'], u['package-ecosystem']).toBeLessThanOrEqual(5);
    }
  });
  it('moves the OpenTelemetry lockstep set as one group', () => {
    const npm = cfg.updates.find((u) => u['package-ecosystem'] === 'npm');
    expect(npm?.groups?.['opentelemetry']?.patterns).toEqual(['@opentelemetry/*']);
  });
});

describe('ci.yml denylist step (R-26)', () => {
  const real = wf('ci.yml');
  const step = /- name: Denylist\n([\s\S]*?)(?=\n {2}[\w-]+:\n|\n {6}- name:|$(?![\s\S]))/.exec(real)?.[1] ?? '';
  it('exists and still checks the content, the commit metadata and the PR text', () => {
    expect(step).toContain('denylist-check.sh');
    expect(step).toContain('git log --format');
  });
  it('fails closed when the secret is missing and one is expected; warns only where Actions secrets are never delivered', () => {
    expect(step).toMatch(/SECRET_EXPECTED:\s*\$\{\{[^}]*github\.event_name == 'push'[^}]*\}\}/);
    expect(step).toMatch(/SECRET_EXPECTED:[^\n]*github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
    expect(step).toMatch(/SECRET_EXPECTED:[^\n]*github\.actor != 'dependabot\[bot\]'/);
    expect(step).toMatch(/if \[ -z "\$DL" \]; then\n\s+if \[ "\$SECRET_EXPECTED" = true \]; then\n\s+echo "::error::[^\n]*"\n\s+exit 1\n\s+fi\n\s+echo "::warning::[^\n]*"\n\s+exit 0/);
  });
});

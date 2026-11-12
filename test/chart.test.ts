// Chart tests (02-07, AC-1..AC-7). They render charts/stralforsmcp with `helm template` and assert the invariants.
// All fixture values are throwaway placeholders; no credentials of any kind are used.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllDocuments, parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const CHART = join(ROOT, 'charts', 'stralforsmcp');
const HELM = process.env.HELM_BIN ?? (spawnSync('helm', ['version']).status === 0 ? 'helm' : '/opt/homebrew/bin/helm');
const helmOk = spawnSync(HELM, ['version']).status === 0;

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const tmp = mkdtempSync(join(tmpdir(), 'chart-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;

const baseValues = (): Obj => ({
  image: { tag: '0.0.0-example' },
  profiles: [{ id: 'test-a', country: 'XX', secretName: 'example-profile-a' }],
  tokenList: { secretName: 'example-token-list' },
  ingress: { internal: { enabled: true, className: 'example', hosts: [{ host: 'mcp.example.invalid', paths: [{ path: '/', pathType: 'Prefix' }] }] } },
});

const valuesFile = (v: Obj) => {
  const f = join(tmp, `values-${seq++}.json`); // JSON is valid YAML for helm -f
  writeFileSync(f, JSON.stringify(v));
  return f;
};

const render = (v: Obj): Obj[] => {
  const out = execFileSync(HELM, ['template', 'rel', CHART, '-f', valuesFile(v)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return parseAllDocuments(out).map((d) => d.toJS() as Obj).filter((d) => d && d.kind);
};

const helmError = (v: Obj): string => {
  const r = spawnSync(HELM, ['template', 'rel', CHART, '-f', valuesFile(v)], { encoding: 'utf8' });
  // a missing chart must not count as the expected validation failure
  if (r.status === 0) return '';
  return `${r.stderr}${r.stdout}`;
};

const kind = (docs: Obj[], k: string) => docs.filter((d) => d.kind === k);
const deployment = (docs: Obj[]) => kind(docs, 'Deployment')[0];
const podSpec = (docs: Obj[]) => deployment(docs).spec.template.spec;
const container = (docs: Obj[]) => podSpec(docs).containers[0];
const envMap = (docs: Obj[]): Record<string, Obj> => Object.fromEntries((container(docs).env ?? []).map((e: Obj) => [e.name, e]));
const envVal = (docs: Obj[], name: string) => envMap(docs)[name]?.value;

const full = (): Obj => ({
  image: { repository: 'registry.example.invalid/stralforsmcp', tag: '0.0.0-example', pullPolicy: 'IfNotPresent', digest: 'sha256:' + 'a'.repeat(64) },
  stralfors: { env: 'test', allowWrite: true, prodValidateEnabled: true, certReloadS: 30 },
  profiles: [
    { id: 'test-a', country: 'XX', secretName: 'example-profile-a', passphrase: true },
    { id: 'test-b', country: 'YY', secretName: 'example-profile-b', passphrase: false },
  ],
  tokenList: { secretName: 'example-token-list', key: 'token-list.json' },
  extraHostnames: ['extra.example.invalid'],
  origins: ['origin.example.invalid'],
  otlp: { endpoint: 'https://otel.example.invalid', headersSecret: { name: 'example-otlp', key: 'headers' } },
  replicas: 2,
  drainMs: 20000,
  terminationGracePeriodSeconds: 45,
  ingress: {
    internal: { enabled: true, className: 'example-internal', hosts: [{ host: 'int.example.invalid', paths: [{ path: '/', pathType: 'Prefix' }] }], tls: [{ secretName: 'example-tls', hosts: ['int.example.invalid'] }] },
    public: { enabled: true, className: 'example-public', hosts: [{ host: 'pub.example.invalid', paths: [{ path: '/', pathType: 'Prefix' }] }] },
  },
  networkPolicy: { enabled: true, prometheusNamespace: 'monitoring', ingressControllerNamespace: 'ingress' },
  serviceAccount: { annotations: { 'example.invalid/role': 'placeholder' } },
});

// ---- server-side variable names, derived from src/ and the README tables ----
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
const srcText = walk(join(ROOT, 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const NAME = /\b(?:STRALFORS|MCP|OTEL)_[A-Z0-9_]+\b/g;
const profileSuffix = /\$\{P\}(_[A-Z0-9_]+)|STRALFORS_PROFILE_<ID>(_[A-Z0-9_]+)/g;
// constants in src that match the naming pattern but are not environment variables
const NOT_ENV = new Set(['STRALFORS_ERROR_KINDS']);
const serverNames = new Set<string>((srcText.match(NAME) ?? []).filter((n) => !n.startsWith('STRALFORS_PROFILE_') && !NOT_ENV.has(n)));
const profileSuffixes = new Set<string>([...(srcText + readme).matchAll(profileSuffix)].map((m) => (m[1] ?? m[2])!));
for (const m of (srcText + readme).matchAll(/STRALFORS_PROFILE_<ID>(_[A-Z0-9_]+)/g)) profileSuffixes.add(m[1]!);
const requiredServer = new Set<string>(
  [...readme.matchAll(/^\| `([A-Z_]+)` \| yes \|/gm)].map((m) => m[1]!),
);
const requiredProfileSuffixes = [...readme.matchAll(/^\| `STRALFORS_PROFILE_<ID>(_[A-Z0-9_]+)` \| yes \|/gm)].map((m) => m[1]!);
const profilePrefix = (id: string) => `STRALFORS_PROFILE_${id.toUpperCase().replaceAll('-', '_')}`;

// A missing helm binary fails in CI and skips visibly elsewhere.
if (!helmOk && process.env.CI) {
  describe('chart', () => { it('helm is installed (required in CI)', () => { throw new Error('helm binary not found'); }); });
}
describe.skipIf(!helmOk)(helmOk ? 'chart' : 'chart (SKIPPED: helm binary not found; required when CI is set)', () => {
  beforeAll(() => {
    // fixture sanity: the scanner found the server contract, so AC-7 cannot pass vacuously
    expect(serverNames.has('MCP_TOKEN_LIST_FILE')).toBe(true);
    expect(requiredServer.size).toBeGreaterThan(0);
    expect(requiredProfileSuffixes).toContain('_CERT_FILE');
  });

  describe('AC-1 minimal render', () => {
    it('renders Deployment, Service, ServiceAccount and Ingress', () => {
      const docs = render(baseValues());
      for (const k of ['Deployment', 'Service', 'ServiceAccount', 'Ingress']) expect(kind(docs, k).length, k).toBeGreaterThan(0);
    });
    it('passes helm lint --strict', () => {
      const r = spawnSync(HELM, ['lint', '--strict', CHART, '-f', valuesFile(baseValues())], { encoding: 'utf8' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
    it('sets the server and per-profile variables', () => {
      const docs = render(baseValues());
      expect(envVal(docs, 'STRALFORS_ENV')).toBe('test');
      expect(envVal(docs, 'STRALFORS_PROFILES')).toBe('test-a');
      expect(envVal(docs, 'MCP_TOKEN_LIST_FILE')).toBe('/run/creds/token-list/token-list.json');
      expect(envVal(docs, 'MCP_HOSTNAMES')).toBe('mcp.example.invalid');
      const P = profilePrefix('test-a');
      expect(envVal(docs, `${P}_COUNTRY`)).toBe('XX');
      expect(envVal(docs, `${P}_CLIENT_ID_FILE`)).toBe('/run/creds/test-a/client-id');
      expect(envVal(docs, `${P}_CLIENT_SECRET_FILE`)).toBe('/run/creds/test-a/client-secret');
      expect(envVal(docs, `${P}_CERT_FILE`)).toBe('/run/creds/test-a/client.pem');
      expect(envVal(docs, `${P}_KEY_FILE`)).toBe('/run/creds/test-a/client.key');
    });
    it('emits the key passphrase file only when passphrase is true', () => {
      const P = profilePrefix('test-a');
      expect(envMap(render(baseValues()))[`${P}_KEY_PASSPHRASE_FILE`]).toBeUndefined();
      const v = baseValues();
      v.profiles[0].passphrase = true;
      expect(envVal(render(v), `${P}_KEY_PASSPHRASE_FILE`)).toBe('/run/creds/test-a/key-passphrase');
    });
    it('joins several profiles into STRALFORS_PROFILES', () => {
      expect(envVal(render(full()), 'STRALFORS_PROFILES')).toBe('test-a,test-b');
    });
  });

  describe('AC-2 no secret material', () => {
    it('renders no Secret object, with every option enabled', () => {
      expect(kind(render(baseValues()), 'Secret')).toEqual([]);
      expect(kind(render(full()), 'Secret')).toEqual([]);
    });
    it('values.yaml holds no credential-shaped value', () => {
      const text = readFileSync(join(CHART, 'values.yaml'), 'utf8');
      expect(text).not.toMatch(/-----BEGIN/);
      const leaves: string[] = [];
      const collect = (x: unknown): void => {
        if (typeof x === 'string') leaves.push(x);
        else if (Array.isArray(x)) x.forEach(collect);
        else if (x && typeof x === 'object') Object.values(x).forEach(collect);
      };
      collect(parse(text));
      expect(leaves.filter((s) => /^[A-Za-z0-9+_=-]{32,}$/.test(s))).toEqual([]);
    });
    it('every *_FILE variable points into a readOnly Secret mount without subPath', () => {
      const docs = render(full());
      const files = Object.values(envMap(docs)).filter((e) => e.name.endsWith('_FILE'));
      expect(files.length).toBeGreaterThan(5);
      const mounts: Obj[] = container(docs).volumeMounts;
      for (const e of files) {
        expect(e.valueFrom, e.name).toBeUndefined();
        const m = mounts.find((x) => (e.value as string).startsWith(`${x.mountPath}/`));
        expect(m, e.name).toBeDefined();
        expect(m!.readOnly, e.name).toBe(true);
        expect(m!.subPath, e.name).toBeUndefined();
        expect(m!.subPathExpr, e.name).toBeUndefined();
      }
    });
    it('mounts each Secret at /run/creds/<id> with defaultMode 288 (0440)', () => {
      const docs = render(full());
      const vols: Obj[] = podSpec(docs).volumes;
      const mounts: Obj[] = container(docs).volumeMounts;
      const want: Record<string, string> = { '/run/creds/test-a': 'example-profile-a', '/run/creds/test-b': 'example-profile-b', '/run/creds/token-list': 'example-token-list' };
      for (const [path, secret] of Object.entries(want)) {
        const m = mounts.find((x) => x.mountPath === path);
        expect(m, path).toBeDefined();
        const vol = vols.find((x) => x.name === m!.name);
        expect(vol?.secret?.secretName, path).toBe(secret);
        expect(vol?.secret?.defaultMode, path).toBe(288);
      }
    });
    it('never uses subPath or immutable anywhere in the rendered chart', () => {
      const text = JSON.stringify(render(full()));
      expect(text).not.toMatch(/subPath/);
      expect(text).not.toMatch(/immutable/);
    });
    it('agreement ids come from an optional secretKeyRef, never a literal', () => {
      const docs = render(baseValues());
      const e = envMap(docs)[`${profilePrefix('test-a')}_ACTION_IDS`];
      expect(e).toBeDefined();
      expect(e.value).toBeUndefined();
      expect(e.valueFrom.secretKeyRef).toEqual({ name: 'example-profile-a', key: 'action-ids', optional: true });
    });
    it('OTLP headers come from a secretKeyRef, never a literal', () => {
      const e = envMap(render(full())).OTEL_EXPORTER_OTLP_HEADERS;
      expect(e).toBeDefined();
      expect(e.value).toBeUndefined();
      expect(e.valueFrom.secretKeyRef).toMatchObject({ name: 'example-otlp', key: 'headers' });
      expect(envVal(render(full()), 'OTEL_EXPORTER_OTLP_ENDPOINT')).toBe('https://otel.example.invalid');
    });
    it('emits no OTLP variables when otlp is not configured', () => {
      const names = Object.keys(envMap(render(baseValues())));
      expect(names.filter((n) => n.startsWith('OTEL_'))).toEqual([]);
    });
  });

  describe('AC-3 hardened pod', () => {
    const sec = (docs: Obj[]) => ({ ...podSpec(docs).securityContext, ...container(docs).securityContext });
    it('runs non-root as 65532 with a hardened container', () => {
      const docs = render(baseValues());
      const pod = podSpec(docs).securityContext;
      expect(pod).toMatchObject({ runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532 });
      const s = sec(docs);
      expect(s.runAsNonRoot).toBe(true);
      expect(s.seccompProfile).toEqual({ type: 'RuntimeDefault' });
      const c = container(docs).securityContext;
      expect(c.readOnlyRootFilesystem).toBe(true);
      expect(c.allowPrivilegeEscalation).toBe(false);
      expect(c.capabilities).toEqual({ drop: ['ALL'] });
    });
    it('does not mount the service account token', () => {
      const docs = render(baseValues());
      expect(podSpec(docs).automountServiceAccountToken).toBe(false);
      expect(kind(docs, 'ServiceAccount')[0].automountServiceAccountToken).toBe(false);
    });
    it('sets resources, probes and a grace period above MCP_DRAIN_MS by default', () => {
      const docs = render(baseValues());
      const c = container(docs);
      for (const side of ['requests', 'limits']) for (const r of ['cpu', 'memory']) expect(c.resources?.[side]?.[r], `${side}.${r}`).toBeTruthy();
      expect(c.livenessProbe.httpGet.path).toBe('/healthz');
      expect(c.readinessProbe.httpGet.path).toBe('/readyz');
      expect(envVal(docs, 'MCP_DRAIN_MS')).toBe('10000');
      expect(podSpec(docs).terminationGracePeriodSeconds).toBe(30);
    });
    it('honours drainMs and terminationGracePeriodSeconds overrides', () => {
      const docs = render(full());
      expect(envVal(docs, 'MCP_DRAIN_MS')).toBe('20000');
      expect(podSpec(docs).terminationGracePeriodSeconds).toBe(45);
    });
    it('declares only Secret volumes by default (no writable volume)', () => {
      const vols: Obj[] = podSpec(render(baseValues())).volumes;
      expect(vols.length).toBeGreaterThan(0);
      for (const v of vols) expect(Object.keys(v).filter((k) => k !== 'name')).toEqual(['secret']);
    });
    it('exposes the mcp and metrics container ports', () => {
      const ports = container(render(baseValues())).ports.map((p: Obj) => p.containerPort);
      expect(ports).toEqual(expect.arrayContaining([3000, 9464]));
    });
    it('applies the image reference, with the digest when given', () => {
      expect(container(render(baseValues())).image).toMatch(/:0\.0\.0-example$/);
      expect(container(render(full())).image).toBe(`registry.example.invalid/stralforsmcp@sha256:${'a'.repeat(64)}`);
    });
  });

  describe('AC-4 prod guards', () => {
    it('refuses prod with allowWrite', () => {
      const v = baseValues();
      v.stralfors = { env: 'prod', allowWrite: true };
      expect(helmError(v)).toContain('allowWrite is never allowed with env=prod');
    });
    it('refuses prod with a public ingress', () => {
      const v = baseValues();
      v.stralfors = { env: 'prod' };
      v.ingress.public = { enabled: true, className: 'example', hosts: [{ host: 'pub.example.invalid', paths: [{ path: '/', pathType: 'Prefix' }] }] };
      expect(helmError(v)).toContain('public ingress is not allowed with env=prod');
    });
    it('renders prod with an internal ingress and no write', () => {
      const v = baseValues();
      v.stralfors = { env: 'prod' };
      const docs = render(v);
      expect(envVal(docs, 'STRALFORS_ENV')).toBe('prod');
      expect(envVal(docs, 'STRALFORS_ALLOW_WRITE')).not.toBe('true');
    });
    it('renders test with allowWrite and sets STRALFORS_ALLOW_WRITE=true', () => {
      const v = baseValues();
      v.stralfors = { env: 'test', allowWrite: true };
      expect(envVal(render(v), 'STRALFORS_ALLOW_WRITE')).toBe('true');
    });
    it('emits STRALFORS_PROD_VALIDATE_ENABLED only when explicitly set', () => {
      expect(envMap(render(baseValues())).STRALFORS_PROD_VALIDATE_ENABLED).toBeUndefined();
      const t = baseValues();
      t.stralfors = { env: 'test', prodValidateEnabled: true };
      expect(envVal(render(t), 'STRALFORS_PROD_VALIDATE_ENABLED')).toBe('true');
      const f = baseValues();
      f.stralfors = { env: 'test', prodValidateEnabled: false };
      expect(envVal(render(f), 'STRALFORS_PROD_VALIDATE_ENABLED')).toBe('false');
    });
  });

  describe('AC-5 networking', () => {
    const mcpSvc = (docs: Obj[]) => kind(docs, 'Service').find((s) => !s.metadata.name.endsWith('-metrics'))!;
    const metricsSvc = (docs: Obj[]) => kind(docs, 'Service').find((s) => s.metadata.name.endsWith('-metrics'))!;
    it('every Ingress backend targets the mcp port 3000 only', () => {
      const docs = render(full());
      const svc = mcpSvc(docs);
      const ing = kind(docs, 'Ingress');
      expect(ing.length).toBe(2);
      for (const i of ing) {
        const backends = i.spec.rules.flatMap((r: Obj) => r.http.paths.map((p: Obj) => p.backend.service));
        expect(backends.length).toBeGreaterThan(0);
        for (const b of backends) {
          expect(b.name).toBe(svc.metadata.name);
          const port = b.port.number ?? svc.spec.ports.find((p: Obj) => p.name === b.port.name)?.port;
          expect(port).toBe(3000);
        }
      }
    });
    it('MCP_HOSTNAMES is the union of ingress hosts and extraHostnames', () => {
      const hosts = (envVal(render(full()), 'MCP_HOSTNAMES') as string).split(',').sort();
      expect(hosts).toEqual(['extra.example.invalid', 'int.example.invalid', 'pub.example.invalid']);
    });
    it('MCP_ORIGINS is emitted only when origins is set', () => {
      expect(envMap(render(baseValues())).MCP_ORIGINS).toBeUndefined();
      expect(envVal(render(full()), 'MCP_ORIGINS')).toBe('origin.example.invalid');
    });
    it('extraHostnames alone satisfy the hostname requirement without an ingress', () => {
      const v = baseValues();
      v.ingress = {};
      v.extraHostnames = ['only.example.invalid'];
      const docs = render(v);
      expect(kind(docs, 'Ingress')).toEqual([]);
      expect(envVal(docs, 'MCP_HOSTNAMES')).toBe('only.example.invalid');
    });
    it('fails when no hostname is configured', () => {
      const v = baseValues();
      v.ingress = {};
      expect(helmError(v)).toContain('at least one hostname');
    });
    it('exposes metrics only through a separate ClusterIP Service', () => {
      const docs = render(baseValues());
      const m = metricsSvc(docs);
      expect(m).toBeDefined();
      expect([undefined, 'ClusterIP']).toContain(m.spec.type);
      expect(m.spec.ports.map((p: Obj) => p.port)).toEqual([9464]);
      const s = mcpSvc(docs);
      expect(s.spec.ports.map((p: Obj) => p.port)).toEqual([3000]);
      expect([undefined, 'ClusterIP']).toContain(s.spec.type);
      expect(m.metadata.name).toBe(`${s.metadata.name}-metrics`);
    });
    it('renders no NetworkPolicy unless enabled', () => {
      expect(kind(render(baseValues()), 'NetworkPolicy')).toEqual([]);
    });
    it('limits 9464 to the Prometheus namespace and 3000 to the ingress controller namespace', () => {
      const [np] = kind(render(full()), 'NetworkPolicy');
      expect(np).toBeDefined();
      expect(np.spec.policyTypes).toContain('Ingress');
      const nsOf = (rule: Obj): string[] => (rule.from ?? []).map((f: Obj) => f.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name']);
      const rules: Obj[] = np.spec.ingress;
      for (const r of rules) {
        expect(r.ports?.length, 'rule without ports opens every port').toBeGreaterThan(0);
        expect(r.from?.length, 'rule without from opens every source').toBeGreaterThan(0);
      }
      const metrics = rules.filter((r) => r.ports.some((p: Obj) => p.port === 9464));
      expect(metrics.length).toBeGreaterThan(0);
      for (const r of metrics) expect(nsOf(r)).toEqual(['monitoring']);
      const mcp = rules.filter((r) => r.ports.some((p: Obj) => p.port === 3000));
      expect(mcp.length).toBeGreaterThan(0);
      for (const r of mcp) expect(nsOf(r)).toEqual(['ingress']);
    });
  });

  describe('AC-6 bad values fail early', () => {
    it('names image.tag when it is missing', () => {
      const v = baseValues();
      delete v.image.tag;
      const e = helmError(v);
      expect(e).toMatch(/image/);
      expect(e).toMatch(/tag/);
    });
    it('names secretName when a profile lacks it', () => {
      const v = baseValues();
      delete v.profiles[0].secretName;
      const e = helmError(v);
      expect(e).toMatch(/profiles/);
      expect(e).toMatch(/secretName/);
    });
    it('names env when it is unknown', () => {
      const v = baseValues();
      v.stralfors = { env: 'staging' };
      expect(helmError(v)).toMatch(/env/);
    });
    it('names replicas when below 1', () => {
      const v = baseValues();
      v.replicas = 0;
      expect(helmError(v)).toMatch(/replicas/);
    });
    it('names the profile id when it is invalid', () => {
      for (const id of ['Bad_ID!', '-lead', 'has space']) {
        const v = baseValues();
        v.profiles[0].id = id;
        const e = helmError(v);
        expect(e, id).toMatch(/profiles/);
        expect(e, id).toMatch(/\bid\b/);
      }
    });
    it('names tokenList.secretName when missing', () => {
      const v = baseValues();
      delete v.tokenList.secretName;
      expect(helmError(v)).toMatch(/secretName/);
    });
  });

  describe('review fixes', () => {
    it('keeps every resource name within 63 chars for a 50-char release name', () => {
      const r = 'r'.repeat(50);
      const v = full();
      v.networkPolicy.enabled = true;
      const out = execFileSync(HELM, ['template', r, CHART, '-f', valuesFile(v)], { encoding: 'utf8' });
      const names = parseAllDocuments(out).map((d) => d.toJS() as Obj).filter((d) => d?.kind).map((d) => d.metadata.name as string);
      expect(names.length).toBeGreaterThan(5);
      for (const n of names) expect(n.length, n).toBeLessThanOrEqual(63);
    });
    it('ignores empty hostnames when checking for at least one', () => {
      const v = baseValues();
      v.ingress = {};
      v.extraHostnames = [''];
      expect(helmError(v)).toContain('at least one hostname');
    });
    it('rejects profile id token-list', () => {
      const v = baseValues();
      v.profiles[0].id = 'token-list';
      const e = helmError(v);
      expect(e).toMatch(/profiles/);
      expect(e).toMatch(/\bid\b/);
    });
    it('fails when the grace period does not exceed drainMs', () => {
      const v = baseValues();
      v.terminationGracePeriodSeconds = 0;
      expect(helmError(v)).toContain('terminationGracePeriodSeconds must be longer than drainMs');
      expect(helmError(baseValues())).toBe('');
    });
    it('rejects unknown networkPolicy keys', () => {
      const v = baseValues();
      v.networkPolicy = { enabld: true };
      expect(helmError(v)).toMatch(/enabld/);
    });
  });

  describe('L5 certReloadS bound', () => {
    const withReload = (n: number) => ({ ...baseValues(), stralfors: { certReloadS: n } });
    it('rejects 2147484 naming the key', () => {
      expect(helmError(withReload(2147484))).toMatch(/certReloadS/);
    });
    it('renders 2147483', () => {
      expect(helmError(withReload(2147483))).toBe('');
      expect(envVal(render(withReload(2147483)), 'STRALFORS_CERT_RELOAD_S')).toBe('2147483');
    });
  });

  describe('README documents every variable the server reads', () => {
    it('every OTEL_/MCP_/STRALFORS_ variable read in src is in a README table row', () => {
      const documented = new Set([...readme.matchAll(/^\|[^\n]*$/gm)].flatMap((m) => m[0].match(NAME) ?? []));
      const missing = [...serverNames].filter((n) => !documented.has(n)).sort();
      expect(missing, `undocumented in README tables: ${missing.join(', ')}`).toEqual([]);
    });
  });

  describe('AC-7 chart and server agree', () => {
    const emitted = () => Object.keys(envMap(render(full()))).filter((n) => /^(STRALFORS|MCP|OTEL)_/.test(n));
    it('every emitted variable is one the server reads', () => {
      const names = emitted();
      expect(names.length).toBeGreaterThan(15);
      const unknown: string[] = [];
      for (const n of names) {
        const m = /^STRALFORS_PROFILE_(?:TEST_A|TEST_B)(_[A-Z0-9_]+)$/.exec(n);
        if (m ? !profileSuffixes.has(m[1]!) : !serverNames.has(n)) unknown.push(n);
      }
      expect(unknown).toEqual([]);
    });
    it('every required server variable is emitted', () => {
      const names = new Set(emitted());
      for (const n of requiredServer) expect(names.has(n), n).toBe(true);
      for (const id of ['test-a', 'test-b']) for (const s of requiredProfileSuffixes) expect(names.has(`${profilePrefix(id)}${s}`), `${id}${s}`).toBe(true);
    });
    it('emits the optional server variables when configured', () => {
      const names = new Set(emitted());
      for (const n of ['STRALFORS_ALLOW_WRITE', 'STRALFORS_PROD_VALIDATE_ENABLED', 'STRALFORS_CERT_RELOAD_S', 'MCP_ORIGINS', 'MCP_DRAIN_MS', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS']) expect(names.has(n), n).toBe(true);
    });
  });
});

// 07-02: every alert rule of the chart is evaluated by Prometheus's own engine (promtool), offline.
// The rules come from `helm template`; the inputs are synthetic series. The container runs with --network none:
// CI never reaches a cluster or a Prometheus server.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAllDocuments, stringify } from 'yaml';
import { docker, integrationEnabled } from './docker.ts';

// Pinned like WireMock (ADR 0019): prom/prometheus v3.16.0 (busybox variant, ships promtool). Bump by hand.
const IMAGE = 'prom/prometheus@sha256:e04987641b57704f408e31f6373ba4138ecf27cb4a165d24aabb6c38fddd0f06';
const CHART = resolve(import.meta.dirname, '..', '..', 'charts', 'stralforsmcp');
const HELM = process.env['HELM_BIN'] ?? 'helm';

const helmOk = spawnSync(HELM, ['version'], { stdio: 'ignore' }).status === 0;
if (!helmOk && process.env['CI']) throw new Error('rules suite: helm is not available but CI is set');
const enabled = helmOk && (await integrationEnabled());

type Obj = Record<string, unknown>;
const L = { namespace: 'ns', job: 'j' };
const sel = (name: string, labels: Record<string, string>) => `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`;
const alert = (alertname: string, evalTime: string, labels: Record<string, string>[]) => ({ eval_time: evalTime, alertname, exp_alerts: labels.map((l) => ({ exp_labels: l })) });

/** One promtool test group per scenario: its own input series, its own expectations. */
const TESTS: { name: string; series: [string, string][]; alerts: ReturnType<typeof alert>[] }[] = [
  {
    name: 'WriteBlocked: a 0 -> 1 step after the series is 5 m old fires (increase leg), and resolves once flat for 5 m',
    series: [[sel('stralfors_write_blocked_total', L), '0x10 1x10']],
    alerts: [
      alert('StralforsMcpWriteBlocked', '9m', []),
      alert('StralforsMcpWriteBlocked', '11m', [{ severity: 'critical', ...L }]),
      alert('StralforsMcpWriteBlocked', '17m', []),
    ],
  },
  {
    name: 'WriteBlocked: a new series whose first sample is already 1 fires (block before the first scrape), then resolves',
    series: [[sel('stralfors_write_blocked_total', L), '_ _ _ 1x12']],
    alerts: [
      alert('StralforsMcpWriteBlocked', '4m', [{ severity: 'critical', ...L }]),
      alert('StralforsMcpWriteBlocked', '10m', []),
    ],
  },
  {
    name: 'WriteBlocked: a constant 0 never fires',
    series: [[sel('stralfors_write_blocked_total', L), '0x15']],
    alerts: [alert('StralforsMcpWriteBlocked', '1m', []), alert('StralforsMcpWriteBlocked', '12m', [])],
  },
  {
    name: 'VendorDown: fires after 10 m of 0, not after 9 m; never while 1',
    series: [[sel('stralfors_up', { api: 'omni', env: 'test', ...L }), '0x15'], [sel('stralfors_up', { api: 'omni', env: 'prod', namespace: 'ns2', job: 'j' }), '1x15']],
    alerts: [
      alert('StralforsMcpVendorDown', '9m', []),
      alert('StralforsMcpVendorDown', '10m', [{ severity: 'critical', api: 'omni', env: 'test', ...L }]),
    ],
  },
  {
    name: 'UpstreamErrors: 25 % errors for 10 m fire; blocked writes cannot dilute the ratio',
    series: [
      [sel('stralfors_requests_total', { operation: 'channels', outcome: 'error', ...L }), '0+1x30'],
      [sel('stralfors_requests_total', { operation: 'channels', outcome: 'ok', ...L }), '0+3x30'],
      [sel('stralfors_write_blocked_total', L), '0+50x30'],
      [sel('stralfors_requests_total', { operation: 'channels', outcome: 'error', namespace: 'ok-ns', job: 'j' }), '0+1x30'],
      [sel('stralfors_requests_total', { operation: 'channels', outcome: 'ok', namespace: 'ok-ns', job: 'j' }), '0+9x30'],
    ],
    alerts: [alert('StralforsMcpUpstreamErrors', '25m', [{ severity: 'warning', ...L }])],
  },
  {
    name: 'CertExpirySoon / Critical: 20 days fires Soon only after 1 h; 5 days fires Critical after 15 m; 40 days fires nothing',
    series: [
      [sel('stralfors_client_cert_expiry_seconds', { ...L, pod: 'a' }), `${20 * 86400}x90`],
      [sel('stralfors_client_cert_expiry_seconds', { ...L, pod: 'b' }), `${5 * 86400}x90`],
      [sel('stralfors_client_cert_expiry_seconds', { ...L, pod: 'c' }), `${40 * 86400}x90`],
    ],
    alerts: [
      alert('StralforsMcpCertExpirySoon', '59m', []),
      alert('StralforsMcpCertExpirySoon', '61m', [{ severity: 'warning', ...L, pod: 'a' }, { severity: 'warning', ...L, pod: 'b' }]),
      alert('StralforsMcpCertExpiryCritical', '14m', []),
      alert('StralforsMcpCertExpiryCritical', '16m', [{ severity: 'critical', ...L, pod: 'b' }]),
    ],
  },
  {
    name: 'TokenListStale: above 300 s for 5 m fires; 300 s exactly does not',
    series: [[sel('mcp_token_list_stale_seconds', { ...L, pod: 'a' }), '400x10'], [sel('mcp_token_list_stale_seconds', { ...L, pod: 'b' }), '300x10']],
    alerts: [alert('StralforsMcpTokenListStale', '4m', []), alert('StralforsMcpTokenListStale', '6m', [{ severity: 'critical', ...L, pod: 'a' }])],
  },
  {
    name: 'CredentialReloadFailing: failed reloads for 15 m fire; ok reloads never do',
    series: [
      [sel('stralfors_credentials_reloads_total', { outcome: 'failed', ...L }), '0+1x40'],
      [sel('stralfors_credentials_reloads_total', { outcome: 'ok', ...L, pod: 'b' }), '0+1x40'],
    ],
    alerts: [alert('StralforsMcpCredentialReloadFailing', '10m', []), alert('StralforsMcpCredentialReloadFailing', '20m', [{ severity: 'warning', outcome: 'failed', ...L }])],
  },
  {
    name: 'ServerErrors: 10 % 5xx for 10 m fire; 1 % does not',
    series: [
      [sel('http_server_request_duration_count', { http_response_status_code: '500', ...L }), '0+1x30'],
      [sel('http_server_request_duration_count', { http_response_status_code: '200', ...L }), '0+9x30'],
      [sel('http_server_request_duration_count', { http_response_status_code: '500', namespace: 'ok-ns', job: 'j' }), '0+1x30'],
      [sel('http_server_request_duration_count', { http_response_status_code: '200', namespace: 'ok-ns', job: 'j' }), '0+99x30'],
    ],
    alerts: [alert('StralforsMcpServerErrors', '25m', [{ severity: 'warning', ...L }])],
  },
  {
    name: "Restarting: more than 2 restarts in 30 m of this release's pod fire; another release's pod does not",
    series: [
      [sel('kube_pod_container_status_restarts_total', { pod: 'rel-stralforsmcp-abc', namespace: 'ns' }), '0 1 2 3 3 3 3 3 3 3'],
      [sel('kube_pod_container_status_restarts_total', { pod: 'other-app-abc', namespace: 'ns' }), '0 1 2 3 3 3 3 3 3 3'],
    ],
    alerts: [alert('StralforsMcpRestarting', '1m', []), alert('StralforsMcpRestarting', '5m', [{ severity: 'warning', pod: 'rel-stralforsmcp-abc', namespace: 'ns' }])],
  },
];

describe.skipIf(!enabled)('07-02 alert rules evaluated by promtool (offline container)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rules-int-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const renderRules = (): Obj => {
    const values = join(dir, 'values.json');
    writeFileSync(values, JSON.stringify({
      image: { tag: '0.0.0-example' },
      profiles: [{ id: 'test-a', country: 'XX', secretName: 'example-profile-a' }],
      tokenList: { secretName: 'example-token-list' },
      ingress: { internal: { enabled: true, className: 'example', hosts: [{ host: 'mcp.example.invalid', paths: [{ path: '/', pathType: 'Prefix' }] }] } },
      prometheusRule: { enabled: true },
    }));
    const out = execFileSync(HELM, ['template', 'rel', CHART, '-f', values], { encoding: 'utf8' });
    const rule = parseAllDocuments(out).map((d) => d.toJS() as Obj).find((d) => d?.['kind'] === 'PrometheusRule')!;
    return { groups: (rule['spec'] as Obj)['groups'] };
  };
  const promtool = (...args: string[]) => docker(['run', '--rm', '--network', 'none', '-v', `${dir}:/w:ro`, '--entrypoint', 'promtool', IMAGE, ...args], 120_000);

  it('the rendered rules file is valid and every alert has a scenario', async () => {
    const rules = renderRules();
    writeFileSync(join(dir, 'rules.yml'), stringify(rules));
    chmodSync(dir, 0o755);
    await promtool('check', 'rules', '/w/rules.yml');
    const names = ((rules['groups'] as Obj[]).flatMap((g) => g['rules'] as Obj[])).map((r) => r['alert']);
    expect(names).toHaveLength(9);
    for (const n of names) expect(TESTS.some((t) => t.alerts.some((a) => a.alertname === n)), String(n)).toBe(true);
  }, 180_000);

  it('dashboard ratio panels show 0, not no data, while no error has ever happened (promql_expr_test)', async () => {
    const values = join(dir, 'dash-values.json');
    writeFileSync(values, JSON.stringify({
      image: { tag: '0.0.0-example' },
      profiles: [{ id: 'test-a', country: 'XX', secretName: 'example-profile-a' }],
      tokenList: { secretName: 'example-token-list' },
      ingress: { internal: { enabled: true, className: 'example', hosts: [{ host: 'mcp.example.invalid', paths: [{ path: '/', pathType: 'Prefix' }] }] } },
      grafanaDashboard: { enabled: true },
    }));
    const out = execFileSync(HELM, ['template', 'rel', CHART, '-f', values], { encoding: 'utf8' });
    const cm = parseAllDocuments(out).map((d) => d.toJS() as Obj).find((d) => d?.['kind'] === 'ConfigMap')!;
    const dash = JSON.parse(Object.values(cm['data'] as Record<string, string>)[0]!) as { panels: { title: string; targets: { expr: string }[] }[] };
    const expr = (title: string) => dash.panels.find((p) => p.title === title)!.targets[0]!.expr.replaceAll('$namespace', '.*').replaceAll('$job', '.*');
    const ratio = (title: string, name: string, errLabels: Record<string, string>, okLabels: Record<string, string>) => ({
      name: `${title}: 0 with no errors ever, 0.25 with one error in four`,
      interval: '1m',
      input_series: [
        { series: sel(name, { ...okLabels, ...L }), values: '0+4x10' },
        { series: sel(name, { ...okLabels, namespace: 'ns2', job: 'j' }), values: '0+3x10' },
        { series: sel(name, { ...errLabels, namespace: 'ns2', job: 'j' }), values: '0+1x10' },
      ],
      promql_expr_test: [{ expr: expr(title), eval_time: '8m', exp_samples: [{ labels: `{job="j",namespace="ns"}`, value: 0 }, { labels: `{job="j",namespace="ns2"}`, value: 0.25 }] }],
    });
    writeFileSync(join(dir, 'empty.yml'), stringify({ groups: [] }));
    writeFileSync(join(dir, 'dash-tests.yml'), stringify({
      rule_files: ['empty.yml'],
      evaluation_interval: '1m',
      tests: [
        ratio('Vendor error ratio', 'stralfors_requests_total', { operation: 'channels', outcome: 'error' }, { operation: 'channels', outcome: 'ok' }),
        ratio('HTTP 5xx ratio', 'http_server_request_duration_count', { http_response_status_code: '500' }, { http_response_status_code: '200' }),
      ],
    }));
    chmodSync(dir, 0o755);
    const r = spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${dir}:/w:ro`, '--entrypoint', 'promtool', IMAGE, 'test', 'rules', '/w/dash-tests.yml'], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  }, 180_000);

  it('every scenario passes promtool test rules', async () => {
    const rules = renderRules();
    writeFileSync(join(dir, 'rules.yml'), stringify(rules));
    // promtool also compares annotations; they are fixed text per alert, so take them from the rendered rules
    const notes = new Map(((rules['groups'] as Obj[]).flatMap((g) => g['rules'] as Obj[])).map((r) => [r['alert'], r['annotations']]));
    const withNotes = (a: ReturnType<typeof alert>) => ({ ...a, exp_alerts: a.exp_alerts.map((e) => ({ ...e, exp_annotations: notes.get(a.alertname) })) });
    writeFileSync(join(dir, 'tests.yml'), stringify({
      rule_files: ['rules.yml'],
      evaluation_interval: '1m',
      tests: TESTS.map((t) => ({ name: t.name, interval: '1m', input_series: t.series.map(([series, values]) => ({ series, values })), alert_rule_test: t.alerts.map(withNotes) })),
    }));
    chmodSync(dir, 0o755);
    // promtool prints every failing case; docker() drops stderr, so read it from a second, non-throwing run when this one fails
    const r = spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${dir}:/w:ro`, '--entrypoint', 'promtool', IMAGE, 'test', 'rules', '/w/tests.yml'], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  }, 180_000);
});

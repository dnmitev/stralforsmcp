# stralforsmcp

> A hosted [Model Context Protocol](https://modelcontextprotocol.io) server for the Strålfors Output Management API — explore channels, inspect rules, validate invoices before sending and query delivery status from Claude Desktop, Cursor or Claude Code.

**Status:** Phase 2 (MCP server). A typed Stralfors client library and a runnable stateless MCP server (token authentication, policy, audit, graceful shutdown, `whoami` tool) exist; the remaining tools follow in later phases. Not yet packaged for installation.

## Why

Integrating with the Strålfors Output Management API means working out channels, per-channel rules and payload shapes across several API products. This server puts the live API and a curated knowledge base behind an MCP interface, so developers, QA and product people can ask questions and validate payloads in plain language before anything is sent.

## Planned capabilities

| Tool | What it does |
|------|--------------|
| `whoami` | Shows your role, allowed environments and the API scopes available to you |
| `list_channels` | Lists delivery channels enabled for an agreement |
| `get_rules` | Shows the validation rules for a channel, in readable form |
| `get_example_invoice` | Returns a reference payload for one or more channels |
| `validate_invoice` | Validates a payload locally and with the API's own dry-run validation — nothing is sent |
| `channel_lookup` | Checks which channels a recipient can receive |
| `track_document` | Shows delivery status for a document |
| `send_invoice` | Sends to the **test** environment only |
| `search_docs` | Searches the knowledge base |

Plus ready-made prompts such as "Check my invoice" and "Which channels exist for a country?".

## Design principles

- **Hosted, credentials server-side only.** Client certificates and OAuth client credentials never leave the server. Users authenticate with personal, revocable tokens.
- **Production is read + validate only.** Write tools are not registered in production, outbound requests go through a deny-by-default allowlist, and the server refuses to start with an unsafe configuration.
- **Stateless Streamable HTTP**, safe to run with multiple replicas.
- **No payloads in logs or traces.** Allowlist-based structured logging with redaction and leak tests.

## Stack

TypeScript 7 · Node.js 24 and 26 · `@modelcontextprotocol/server` v2 (Streamable HTTP) · undici (mTLS) · zod · pino · OpenTelemetry · Vitest · StrykerJS · Testcontainers + WireMock · oxlint · Docker · Helm

## Quality gates

| Gate | Threshold |
|------|-----------|
| Line coverage | ≥ 90 % |
| Mutation score (core modules) | ≥ 80 % target, CI fails below 70 % |
| Tests | 100 % passing on Node 24 and 26 |
| Lint + typecheck | 0 errors |
| Secret scanning | 0 findings |
| Container scan | 0 fixable high/critical |

CI publishes coverage, test pass rate and mutation score on every pull request.

## Roadmap

| Phase | Scope |
|-------|-------|
| 0 | Foundation: toolchain, leak guards, CI with reporting |
| 1 | API client: OAuth client credentials + mTLS, token caching, typed responses, structured logging |
| 2 | MCP core: Streamable HTTP, per-user auth, policy, audit log, tracing and metrics, container image, first Kubernetes deployment |
| 3 | Validation: rules, example payloads, dry-run validation, channel lookup, tracking |
| 4 | Knowledge: searchable knowledge base, resources and prompts |
| 5 | Additional countries and channels; test-environment sending |
| 6 | Production: full Helm chart, dashboards and alerts, Claude Desktop extension |

## Stralfors client (library)

`src/stralfors/` holds the API client (OAuth client credentials over mTLS, token caching). Configuration is read from the environment by `loadConfig`; secrets are given as file paths, never values.

| Variable | Required | Default |
|----------|----------|---------|
| `STRALFORS_ENV` | yes | `test` or `prod` |
| `STRALFORS_PROFILES` | yes | comma-separated profile ids, e.g. `test-a` |
| `STRALFORS_ALLOW_WRITE` | no | `false` (never `true` in prod) |
| `STRALFORS_PROD_VALIDATE_ENABLED` | no | `false` |
| `STRALFORS_TIMEOUT_MS` | no | `30000` |
| `STRALFORS_TOKEN_REFRESH_MARGIN_S` | no | `300` |
| `STRALFORS_MAX_BODY_BYTES` | no | `8388608` |

Per profile, with `<ID>` the upper-cased profile id (`-` becomes `_`, so `test-a` gives `TEST_A`):

| Variable | Required | Meaning |
|----------|----------|---------|
| `STRALFORS_PROFILE_<ID>_COUNTRY` | yes | country code |
| `STRALFORS_PROFILE_<ID>_CLIENT_ID_FILE` | yes | file holding the OAuth client id |
| `STRALFORS_PROFILE_<ID>_CLIENT_SECRET_FILE` | yes | file holding the OAuth client secret |
| `STRALFORS_PROFILE_<ID>_CERT_FILE` | yes | client certificate (PEM) |
| `STRALFORS_PROFILE_<ID>_KEY_FILE` | yes | private key (PEM) |
| `STRALFORS_PROFILE_<ID>_KEY_PASSPHRASE_FILE` | no | file holding the key passphrase |
| `STRALFORS_PROFILE_<ID>_ACTION_IDS` | no | comma-separated agreement ids, optionally labelled: `label:uuid,uuid` |

Smoke check against the live test API (manual, never run in CI): export the variables above, then `npm run live:channels`. It prints the token scopes, the client channel catalogue and the channels of each configured agreement by label (or `#1`, `#2`), never by id.

## Running

`node src/server/main.ts` starts the stateless Streamable HTTP MCP server (SDK v2). It creates one Stralfors client per credential profile at start and serves `whoami` and `list_channels` to authenticated callers. Configuration is read from the environment; an invalid value refuses to start (exit 1, `refusing to start: <fixed text>`).

| Variable | Required | Default | Rule |
|---|---|---|---|
| `MCP_TOKEN_LIST_FILE` | yes | none | path to the token list |
| `MCP_HOSTNAMES` | yes | none | comma-separated allowed Host hostnames (no scheme, no port; IPv6 bare or bracketed, no ports) |
| `MCP_ORIGINS` | no | `MCP_HOSTNAMES` | allowed Origin hostnames, same format |
| `MCP_LISTEN_HOST` | no | `0.0.0.0` | listen address |
| `MCP_PORT` | no | `3000` | integer 0-65535 |
| `MCP_MAX_BODY_BYTES` | no | `1048576` | integer > 0 |
| `MCP_DRAIN_MS` | no | `10000` | integer >= 0, in-flight drain on SIGTERM/SIGINT |
| `STRALFORS_ENV` | yes | none | `test` or `prod` |
| `STRALFORS_ALLOW_WRITE` | no | `false` | `true` or `false`; `true` is refused with `prod` |
| `MCP_RATE_PER_MINUTE` | no | `120` | integer >= 1, per-principal refill (per pod) |
| `MCP_RATE_BURST` | no | `30` | integer >= 1, per-principal bucket size |
| `MCP_TOKEN_STALE_MS` | no | `900000` | integer >= 1, a failing token list reload this long logs one `token_list.stale` line |
| `MCP_METRICS_PORT` | no | `9464` | integer 0-65535 (`0` = random), the separate `/metrics` listener |
| `MCP_METRICS_HOST` | no | `0.0.0.0` | metrics listen address, non-empty |
| `MCP_TRACE_SAMPLE_RATIO` | no | `0.1` | decimal 0 to 1 (`0`, `.5`, `0.25`, `1.0`; no sign, exponent or percent): fraction of requests whose trace is exported |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | unset | `http(s)` base URL of an OTLP/HTTP collector; unset or empty = spans are created but not exported |
| `STRALFORS_PROFILES`, `STRALFORS_PROFILE_<ID>_*` | yes | none | profile variables as read by the Stralfors client library (see above); secrets by file path only |

Request pipeline (first match answers; refusals 3-7 are not audited, 401s and tool calls are):

| # | Condition | Status |
|---|---|---|
| 1 | `/healthz` | 200 `ok` (no Host or token needed) |
| 2 | `/readyz` | 200 `ok`, 503 `not ready` once shutdown starts |
| 3 | Host not allowed (or absent) | 403 |
| 4 | Origin present and not allowed | 403 |
| 5 | path is not `/mcp` | 404 |
| 6 | method is not `POST` | 405 (`Allow: POST`) |
| 7 | declared `Content-Length` above the limit | 413 |
| 8 | missing, malformed, unknown, revoked, expired or not-yet-valid token | 401, identical body for every cause |
| 8b | authenticated but over the per-principal rate limit | 429 `too many requests`, `Retry-After` (audited) |
| 9 | authenticated | MCP handler (streamed bodies above the limit: 413) |

### Local run against TEST

1. Create a token list (a user and one token). The raw token is printed once to your terminal; only its hash goes into the file:

   ```sh
   node -e "import('./src/auth/index.ts').then(({generateToken,hashToken})=>{const t=generateToken(),n=Date.now(),d=864e5;console.error('token (keep private):',t);console.log(JSON.stringify({users:[{id:'me',name:'Me',role:'dev',envs:['test']}],tokens:[{hash:hashToken(t),userId:'me',created:new Date(n).toISOString(),expires:new Date(n+30*d).toISOString()}]},null,2))})" > token-list.json
   ```

2. Export `STRALFORSMCP_TOKEN` from the token printed in step 1 (in your shell only, never in a file in this repository), `MCP_TOKEN_LIST_FILE` (that file), `MCP_HOSTNAMES=localhost`, `STRALFORS_ENV=test` and the `STRALFORS_PROFILES` / `STRALFORS_PROFILE_<ID>_*` variables pointing at your credential files (paths only; never put secret values in the environment or on the command line).
3. `node src/server/main.ts`, then `curl localhost:3000/healthz`.
4. Add `{"type":"http","url":"http://localhost:3000/mcp","headers":{"Authorization":"Bearer ${STRALFORSMCP_TOKEN}"}}` to `.mcp.json` and call `whoami`, then `list_channels`.

## Container image

The image is built from the `Dockerfile`: a digest-pinned distroless Node 26 `nonroot` base (uid 65532, no shell, no package manager), the repository's `src/` TypeScript run directly by Node's native type stripping (no compile step), and production dependencies only. It declares no `HEALTHCHECK` (use the Kubernetes probes on `/healthz` and `/readyz`), and no credential or configuration value is baked in: `STRALFORS_*` and `MCP_*` are file paths and names supplied at run time.

Build and smoke-test it locally (the smoke test starts the image with `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges` and user `65532:65532` against a generated throwaway fixture, then checks `/healthz`, `/metrics`, the fixed 401 and a clean SIGTERM exit; it needs Docker and `openssl`):

```sh
docker build -t stralforsmcp:local .
node scripts/image-smoke.ts stralforsmcp:local
```

Run it against TEST with your own credential directory mounted read-only. Values are paths inside the container and plain names only; the metrics port 9464 is deliberately not published to the host:

```sh
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges --user 65532:65532 \
  -p 127.0.0.1:3000:3000 -v "$PWD/creds:/run/creds:ro" \
  -e MCP_TOKEN_LIST_FILE=/run/creds/token-list.json -e MCP_HOSTNAMES=localhost -e STRALFORS_ENV=test \
  -e STRALFORS_PROFILES=<id> -e STRALFORS_PROFILE_<ID>_COUNTRY=<cc> \
  -e STRALFORS_PROFILE_<ID>_CLIENT_ID_FILE=/run/creds/client-id -e STRALFORS_PROFILE_<ID>_CLIENT_SECRET_FILE=/run/creds/client-secret \
  -e STRALFORS_PROFILE_<ID>_CERT_FILE=/run/creds/client.pem -e STRALFORS_PROFILE_<ID>_KEY_FILE=/run/creds/client.key \
  stralforsmcp:local
```

Port 9464 (Prometheus text) has no authentication. In a cluster, reach it from the Prometheus namespace only (NetworkPolicy) and never expose it through the ingress; port 3000 is the only MCP endpoint.

### Pipeline and tags

`.github/workflows/image.yml` runs on every pull request and on pushes to `main` and `v*` tags.

- `build-scan` (all events, read-only, no secrets, no registry login, nothing pushed): builds linux/amd64, checks the image content, runs the smoke test, runs a Trivy gate that fails on fixable HIGH/CRITICAL vulnerabilities in the image and on HIGH/CRITICAL misconfigurations in the `Dockerfile`, and uploads a CycloneDX SBOM and a Trivy report as the `image-sbom-and-scan` artifact (14 days). Exceptions go only in `.trivyignore.yaml`; each entry needs a `statement` and an `expired_at` at most 90 days ahead (enforced by a test).
- `publish` (push events only, never a pull request or a fork, the only job with `packages: write`): rebuilds linux/amd64 and linux/arm64, pushes to `ghcr.io/<owner>/stralforsmcp` with BuildKit SBOM and `provenance: mode=max` attestations. The pushed digest is a rebuild, not byte for byte the scanned image.

Tags: `sha-<40 hex commit>` on every publish, `edge` on `main`, `X.Y.Z`, `X.Y` and `latest` on `v*` release tags only. Deploy by digest, never by `edge` or `latest`.

Find the digest in the workflow run summary or with `docker buildx imagetools inspect ghcr.io/<owner>/stralforsmcp:sha-<commit>`. The SBOM and provenance attestations are read with `docker buildx imagetools inspect <ref> --format '{{json .SBOM}}'` and `--format '{{json .Provenance}}'`; the Trivy SBOM is the workflow artifact. Signing (cosign) is not done yet.

The GHCR package is private after the first push. Making it public is the maintainer's irreversible decision in the GitHub package settings; the workflow never changes it.

Check what the image contains (no tests, scripts, docs, `.paul`, credentials, shell or npm outside `node_modules`):

```sh
docker create --name content stralforsmcp:local && docker export content | tar -t | grep -v '^app/node_modules/'; docker rm content
```

### Bumping pins

Every pin is updated by hand in one reviewed pull request; the image workflow is the test. No update bot is configured yet.

- Base images: `docker buildx imagetools inspect gcr.io/distroless/nodejs26-debian13:nonroot` (and `node:26-trixie-slim`), then replace the index digest after `@sha256:` in the matching `FROM`.
- Trivy: take the new version's `trivy_<version>_checksums.txt` from its GitHub release and update the version and the `Linux-64bit` sha256 in the "Install trivy" step.
- Actions: resolve `git/ref/tags/<tag>` of the action (dereference annotated tags through `git/tags/<sha>`), then update the full commit SHA and the version comment.
- The scan reflects the vulnerability database at build time and ignores findings without a fix; there is no scheduled rescan of published images yet.

## Observability

Manual instrumentation only (no auto-instrumentation, no loader hook). Traces go over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; metrics are pulled by Prometheus from a second listener (`MCP_METRICS_HOST:MCP_METRICS_PORT`, `GET /metrics`). The MCP port answers 404 for `/metrics`; keep the metrics port off the ingress and reachable from Prometheus only (NetworkPolicy). An incoming `traceparent` is ignored (every request is its own root span) and none is sent to Stralfors. No span or label carries a payload, token, user id, agreement id, path, query or exception message.

Spans: `POST /mcp` (server), `mcp.tool <name>` (internal), `stralfors.request` (client). Attribute keys are a closed set: `http.request.method`, `http.response.status_code`, `http.route`, `error.type`, `tool`, `outcome`, `env`, `stralfors.operation`.

| Prometheus name (as exported) | Type | Labels |
|---|---|---|
| `http_server_request_duration_{bucket,sum,count}` (seconds) | histogram | `http_request_method` (known methods or `_OTHER`), `http_response_status_code`, `http_route` (always `/mcp`) |
| `mcp_auth_rejections_total` | counter | `reason` (`malformed`, `unknown`, `expired`, `revoked`) |
| `mcp_http_rate_limited_total` | counter | none |
| `mcp_tool_calls_total` | counter | `tool`, `outcome` (`allowed`, `denied`, `error`), `env` |
| `mcp_tool_duration_{bucket,sum,count}` (seconds) | histogram | `tool`, `outcome` |
| `stralfors_requests_total` | counter | `operation`, `outcome` (`ok`, `error`), `error_type` |
| `stralfors_request_duration_{bucket,sum,count}` (seconds) | histogram | `operation`, `outcome`, `error_type` |
| `mcp_token_list_stale_seconds` | gauge | none |
| `target_info` | info | `service_name`, `service_version`, `deployment_environment_name` |

Units are `# UNIT` lines, not name suffixes. Health probes are not measured.

Scrape example (named port `metrics`, not routed by the ingress):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
spec:
  endpoints:
    - port: metrics
      path: /metrics
```

Logs and audit lines written inside a request carry `trace_id` (32 hex) and, on log lines, `span_id` (16 hex). `traceId` in an audit or log line is the Stralfors vendor request id; `trace_id` is this server's trace. Loki derived field (never a Loki label): `"trace_id":"(\w+)"`.

## Mutation testing

`npm run mutation` runs [StrykerJS](https://stryker-mutator.io) with the Vitest runner over the core modules (`src/stralfors/token.ts`, `errors.ts`, `http.ts`, `index.ts`, `config.ts`, `src/auth/token-store.ts`, `src/policy/policy.ts`, `src/audit/audit.ts`, `src/server/auth.ts`, `src/server/tools.ts`, `src/server/guards.ts`, `channels.ts`, `rate-limit.ts`, `context.ts`). Target score is 80 %; the run fails below 70 % (`break`). Reports land in `reports/mutation/` (`mutation.html`, `mutation.json`). The incremental file `reports/stryker-incremental.json` is kept between runs, so a re-run only tests what changed. CI runs this as the `mutation` job on Node 24, publishes the score in the job summary and uploads the report as an artifact.

Optional dashboard: enable the repository on the [Stryker dashboard](https://dashboard.stryker-mutator.io), then run `gh secret set STRYKER_DASHBOARD_API_KEY`. Until the secret exists, CI sends nothing.

## Contributing

Run once after cloning:

```sh
scripts/setup-hooks.sh
```

This activates the commit hooks in `.githooks/`: every commit is scanned with [gitleaks](https://github.com/gitleaks/gitleaks) (must be installed) and, optionally, against a personal denylist of terms that must never be committed. Set `STRALFORSMCP_DENYLIST` to the denylist path (one case-insensitive regex per line); matches are reported as a count only. Run `sh scripts/test-leak-guard.sh` to verify the guard.

Pull requests to `main` need green CI (Node 24 and 26, leak scan) and a `review/confidence` status of at least 90 % from the principal-reviewer agent (`.claude/agents/`) on the head commit; a new push requires a new review.

## Licence

[Apache-2.0](LICENSE)

## Disclaimer

Independent, unofficial project. Not affiliated with or endorsed by PostNord Strålfors. Refer to the official developer portal for authoritative API documentation.

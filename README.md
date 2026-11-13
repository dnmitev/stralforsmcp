# stralforsmcp

> A hosted [Model Context Protocol](https://modelcontextprotocol.io) server for the Strålfors Output Management API — explore channels, inspect rules, validate invoices before sending and query delivery status from Claude Desktop, Cursor or Claude Code.

**Status:** Phase 2 (MCP server). A typed Stralfors client library and a runnable stateless MCP server (token authentication, policy, audit, graceful shutdown, `whoami` tool) exist; the remaining tools follow in later phases. Packaged as a container image, a Helm chart and a Claude Desktop extension (`.mcpb`); the operator installs the server.

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
| 2 | MCP core: Streamable HTTP, per-user auth, policy, audit log, tracing and metrics, container image, Helm chart, Claude Desktop extension (the EKS deployment itself is done by the operator, outside this repository) |
| 3 | Validation: rules, example payloads, dry-run validation, channel lookup, tracking |
| 4 | Knowledge: searchable knowledge base, resources and prompts |
| 5 | Additional countries and channels; test-environment sending |
| 6 | Production: full Helm chart, dashboards and alerts, extension signing and distribution |

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
| `STRALFORS_CERT_RELOAD_S` | no | `60` (seconds between checks of the cert and key files, positive integer) |

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

Certificate rotation: the cert, key and passphrase files are re-read every `STRALFORS_CERT_RELOAD_S` seconds. When their content changed, the client switches to a new connection pool with the new material and lets in-flight requests finish on the old one; no restart is needed. Bad files (unreadable, empty, not PEM, key not opening) keep the last good material and log one `credentials.reload_failed` warning per kind, without paths or content. The client id and secret files are read at start only; rotating them needs a restart (see ADR 0013).

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
| `MCP_LOG_LEVEL` | no | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`; logs go to stderr |
| `STRALFORS_ENV` | yes | none | `test` or `prod` |
| `STRALFORS_ALLOW_WRITE` | no | `false` | `true` or `false`; `true` is refused with `prod` |
| `MCP_RATE_PER_MINUTE` | no | `120` | integer >= 1, per-principal refill (per pod) |
| `MCP_TOOL_OUTPUT_MAX_BYTES` | no | `262144` | integer >= 1; a tool result larger than this is refused (`tool output too large`), never truncated |
| `MCP_RULES_CACHE_S` | no | `3600` | integer 0-86400; per-pod TTL of cached Stralfors rules, `0` disables the cache |
| `MCP_RATE_BURST` | no | `30` | integer >= 1, per-principal bucket size |
| `MCP_TOKEN_STALE_MS` | no | `900000` | integer >= 1, a failing token list reload this long logs one `token_list.stale` line |
| `MCP_METRICS_PORT` | no | `9464` | integer 0-65535 (`0` = random), the separate `/metrics` listener |
| `MCP_METRICS_HOST` | no | `0.0.0.0` | metrics listen address, non-empty |
| `MCP_TRACE_SAMPLE_RATIO` | no | `0.1` | decimal 0 to 1 (`0`, `.5`, `0.25`, `1.0`; no sign, exponent or percent): fraction of requests whose trace is exported |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | unset | `http(s)` base URL of an OTLP/HTTP collector; unset or empty = spans are created but not exported |
| `OTEL_EXPORTER_OTLP_HEADERS` | no | unset | OTLP request headers, read by the OpenTelemetry exporter. Carries credentials: put it in a secret, never in a values file or log. Read at start only (a change needs a restart). With any OTLP headers set, a non-loopback `http` endpoint is refused: the endpoint must be `https` |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | no | unset | Same as `OTEL_EXPORTER_OTLP_HEADERS`, for the trace exporter only; same credential, start-only and https-only rules |
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

Prerequisites: Node 24+, `npm ci` run once in this checkout, and your TEST credential files (client id, client secret, client certificate and key) readable by you.

1. **Configure.** Copy the template and edit the paths. `.env.local` is git-ignored; it holds file paths only, never secret values.

   ```sh
   cp .env.example .env.local
   ```

   Set the `STRALFORS_PROFILE_DEV_*_FILE` paths (the profile id `dev` becomes `DEV` in the names; rename it if you like, upper case, `-` as `_`). `MCP_DRAIN_MS=0` is there so restarts under `--watch` are instant; `MCP_LOG_LEVEL=debug` adds log lines.

2. **Create a token.** Writes `token-list.json` (one user, role `dev`, env `test`, valid 30 days; path from `MCP_TOKEN_LIST_FILE` in `.env.local`, default `./token-list.json`). The file holds only the token's hash. The raw token is printed once, to stderr; copy it now. An existing file is not overwritten unless you add `--force`.

   ```sh
   npm run dev:token
   export STRALFORSMCP_TOKEN=<the token printed above>   # this shell only, never in a file in this repository
   ```

3. **Start the server** (leave it running; use a second terminal, with `STRALFORSMCP_TOKEN` exported there too, for the rest). It restarts when a source file changes (`node --watch`).

   ```sh
   npm run dev
   ```

   There is no "listening" line at `info`; at `debug` there is a `listening` line. The first output is a one-line stderr notice (`responseMode: 'json' drops mid-call notifications ...`, harmless). If it prints `refusing to start: ...`, see the table below; `--watch` then waits, so fix the cause and save a file (or restart it). If a port is busy, check it first:

   ```sh
   lsof -nP -iTCP:3000 -iTCP:9464 -sTCP:LISTEN
   ```

   Stop the other process (`kill <PID>`) or set `MCP_PORT` / `MCP_METRICS_PORT` in `.env.local`, and use your port wherever the steps say 3000. Stop the dev server with Ctrl-C.

4. **Verify** (replace 3000 if you chose another port; the header is piped to curl with `-H @-` so the token never appears in process arguments). Health, then an authenticated call that needs no MCP client:

   ```sh
   curl -s localhost:3000/healthz        # ok
   printf 'Authorization: Bearer %s\n' "$STRALFORSMCP_TOKEN" | curl -s -X POST localhost:3000/mcp \
     -H @- \
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   curl -s localhost:9464/metrics | head   # Prometheus metrics (use your MCP_METRICS_PORT instead of 9464)
   ```

   The second prints an `event: message` / `data: {"result":{"tools":[...` response listing `whoami` and `list_channels`. A `401` means the token is wrong (see below).

5. Add `{"type":"http","url":"http://localhost:3000/mcp","headers":{"Authorization":"Bearer ${STRALFORSMCP_TOKEN}"}}` to `.mcp.json` and call `whoami`, then `list_channels`. For Claude Desktop use the extension instead (see "Claude Desktop extension" below).

#### Debugging

`npm run dev:debug` is `npm run dev` with the Node inspector on `127.0.0.1:9229`; `npm run dev:debug:brk` also pauses on the first line until a debugger attaches. After a `--watch` restart the debugger must reattach (the VS Code configuration does so by itself).

- **VS Code:** run the "Attach to dev server" launch configuration (`.vscode/launch.json`) while `dev:debug` runs, or use "Launch dev server" on its own (no watch, no restart on change).
- **Chrome / Edge:** open `chrome://inspect`, and under Remote Target choose "inspect" for the Node process.
- **JetBrains:** Run | Attach to Node.js/Chrome, port 9229 (or a "Attach to Node.js/Chrome" run configuration).

Logs: set `MCP_LOG_LEVEL` (`trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`; default `info`). Log lines are JSON on **stderr**; audit lines (one per authenticated call) are JSON on **stdout**. Tokens, token hashes and credentials are never logged at any level. To read the logs, split the streams and optionally pretty-print them (a convenience; `pino-pretty` is not a dependency and is fetched by `npx`):

```sh
npm run dev 2>&1 >/dev/null | npx pino-pretty      # logs only
npm run dev 2>/dev/null                              # audit only
```

#### Troubleshooting

`healthz` answering `ok` on the wrong port, or a `401` for a token you just created, usually means an old server is still running on that port with an old token list: run the `lsof` check in step 3, stop it, and start again. After stopping a server wait a few seconds (the drain), or set `MCP_DRAIN_MS=0`, before starting the next one.

| Message or symptom | Cause | Fix |
|---|---|---|
| `refusing to start: metrics listener failed (port in use or not permitted; see MCP_METRICS_PORT)` | port 9464 (or `MCP_METRICS_PORT`) is taken, e.g. by an earlier server, or not allowed | `lsof -nP -iTCP:3000 -iTCP:9464 -sTCP:LISTEN`; stop the other process (wait a few seconds after stopping a server, or set `MCP_DRAIN_MS=0`) or set `MCP_METRICS_PORT` |
| `refusing to start: HTTP listener failed (port in use or not permitted; see MCP_PORT)` | same for port 3000 / `MCP_PORT` | same check; stop the other process or set `MCP_PORT` |
| `node: .env.local: not found` | `npm run dev` without the env file | `cp .env.example .env.local` (step 1) |
| `refusing to start: unexpected error` | a failure that is not a configuration error | rerun with the same environment and check the stderr lines above it |
| `missing MCP_TOKEN_LIST_FILE` / `missing MCP_HOSTNAMES` | variable missing from `.env.local` (or not exported, if you run `node` directly) | step 1 |
| `<name> is invalid` (`MCP_HOSTNAMES`, `MCP_ORIGINS`, `MCP_PORT`, `MCP_METRICS_PORT`, `MCP_METRICS_HOST`, `MCP_MAX_BODY_BYTES`, `MCP_DRAIN_MS`, `MCP_LOG_LEVEL`, `MCP_RATE_PER_MINUTE`, `MCP_RATE_BURST`, `MCP_TOOL_OUTPUT_MAX_BYTES`, `MCP_RULES_CACHE_S`, `MCP_TOKEN_STALE_MS`, `MCP_TRACE_SAMPLE_RATIO`, `STRALFORS_ALLOW_WRITE`, `STRALFORS_ENV`, which must be `test` here) | value is not a valid host list, whole number in range, ratio or `true`/`false` | correct it; ports are 0-65535, hostnames carry no scheme or port |
| `OTEL_EXPORTER_OTLP_ENDPOINT is invalid` / `... must be https when OTLP headers are set` | bad collector URL, or headers would travel in cleartext off the host | fix the URL or unset the OTLP variables |
| `write is never allowed in prod (STRALFORS_ALLOW_WRITE)` | prod with write enabled | unset `STRALFORS_ALLOW_WRITE` |
| `<name> must be true or false` (`STRALFORS_ALLOW_WRITE`, `STRALFORS_PROD_VALIDATE_ENABLED`) | other value | use `true` or `false` |
| `STRALFORS_PROFILES is empty` / `missing STRALFORS_PROFILES` | no profile id listed | step 1 |
| `missing STRALFORS_PROFILE_<ID>_...` | a profile variable is missing from `.env.local`, or `<ID>` is mis-spelt (upper case, `-` becomes `_`) | step 1 |
| `cannot read file of <name>` / `file of <name> is empty` | path wrong, not readable by you, or empty | fix the path and permissions |
| `STRALFORS_CERT_RELOAD_S must be a positive integer` / `... at most 2147483` | bad reload interval | correct or unset it |
| `STRALFORS_PROFILE_<ID>_ACTION_IDS: invalid agreement id (...)` | an entry is not a UUID | fix the entry |
| `token list: cannot read` | `MCP_TOKEN_LIST_FILE` missing or unreadable | step 2 |
| `token list: <field> <rule>` | the file is not a valid token list | recreate it with step 2 (`npm run dev:token -- --force`) |
| `401` on `/mcp` | missing, wrong, expired or revoked token; the body is identical for every cause | recreate the token (step 2, `-- --force` to replace the file), export it again, restart if it still fails |
| `403` / `404` / `405` on `/mcp` | host not in `MCP_HOSTNAMES`, wrong path, or not `POST` | use `localhost` and `POST /mcp` |

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

The container user is uid 65532, so host-owned `0600` files in the mounted directory are unreadable and start-up fails with `cannot read file of ...`. Give the files to a group with GID 65532 instead: on a dedicated directory, `chgrp -R 65532 creds && chmod 750 creds && chmod 440 creds/*` (the owner keeps read access; `chgrp` to a GID you are not a member of may need `sudo`). Alternatively keep the files' existing group with mode `0440` and add `--group-add <that gid>` to `docker run`; the directory must then also belong to that group with mode `0750` (`chgrp <gid> creds && chmod 750 creds`), because a host-owned `0700` directory cannot be traversed by uid 65532 even when the files are readable. Never use `0644` (world-readable) for real secrets; the smoke test uses it on purpose because its fixture is generated per run and deleted afterwards.

Port 9464 (Prometheus text) has no authentication. In a cluster, reach it from the Prometheus namespace only (NetworkPolicy) and never expose it through the ingress; port 3000 is the only MCP endpoint.

### Pipeline and tags

`.github/workflows/image.yml` runs on every pull request and on pushes to `main` and `v*` tags.

- `build-scan` (all events, read-only, no secrets, no registry login, nothing pushed): builds linux/amd64 (loaded, smoke-tested) and linux/arm64 (exported as an archive, scanned but never started), checks the image content, runs the smoke test on amd64 only, runs the same Trivy gate that fails on fixable HIGH/CRITICAL vulnerabilities on both images and on HIGH/CRITICAL misconfigurations in the `Dockerfile`, and uploads a CycloneDX SBOM and a Trivy report as the `image-sbom-and-scan` artifact (14 days; both are generated before the gates, so a failing gate still uploads them). Exceptions go only in `.trivyignore.yaml`; each entry needs a `statement` and an `expired_at` at most 90 days ahead (enforced by a test).
- `publish` (push events only, never a pull request or a fork, the only job with `packages: write`): rebuilds linux/amd64 and linux/arm64, pushes to `ghcr.io/<owner>/stralforsmcp` with BuildKit SBOM and `provenance: mode=max` attestations. The pushed digest is a rebuild, not byte for byte the scanned image.

Tags: `sha-<40 hex commit>` on every publish, `edge` on `main`, `X.Y.Z`, `X.Y` and `latest` on `v*` release tags only. Deploy by digest, never by `edge` or `latest`.

Find the digest in the workflow run summary or with `docker buildx imagetools inspect ghcr.io/<owner>/stralforsmcp:sha-<commit>`. The SBOM and provenance attestations are read with `docker buildx imagetools inspect <ref> --format '{{json .SBOM}}'` and `--format '{{json .Provenance}}'`; the Trivy SBOM is the workflow artifact. Signing (cosign) is not done yet.

The GHCR package is private after the first push. Making it public is the maintainer's irreversible decision in the GitHub package settings; the workflow never changes it.

Check what the image contains (no tests, scripts, docs, `.paul`, credentials, shell or npm outside `node_modules`):

```sh
cid=$(docker create stralforsmcp:local) && { docker export "$cid" | tar -t | grep -v '^app/node_modules/'; docker rm "$cid"; }
```

### Bumping pins

Every pin is updated by hand in one reviewed pull request; the image workflow is the test. No update bot is configured yet.

- Base images: `docker buildx imagetools inspect gcr.io/distroless/nodejs26-debian13:nonroot` (and `node:26-trixie-slim`), then replace the index digest after `@sha256:` in the matching `FROM`.
- Trivy: take the new version's `trivy_<version>_checksums.txt` from its GitHub release and update the version and the `Linux-64bit` sha256 in the "Install trivy" step.
- Actions: resolve `git/ref/tags/<tag>` of the action (dereference annotated tags through `git/tags/<sha>`), then update the full commit SHA and the version comment.
- The scan reflects the vulnerability database at build time and ignores findings without a fix; there is no scheduled rescan of published images yet.

## Helm chart

`charts/stralforsmcp` deploys the image to Kubernetes; see [charts/stralforsmcp/README.md](charts/stralforsmcp/README.md) for all values and guards. The chart never creates or holds a Secret: you create these (names are yours, referenced from values) and the chart mounts them as directories so rotation reaches the pod for the files (certificate, key, passphrase hot-swap; token list reload). Client id and secret, `action-ids` and the OTLP headers Secret need a pod restart after rotation (the last two are read once through env `secretKeyRef`).

- `tokenList.secretName`: key `token-list.json`.
- each `profiles[].secretName`: keys `client-id`, `client-secret`, `client.pem`, `client.key`; optional `key-passphrase`, `action-ids`.
- optional `otlp.headersSecret.name`: key `headers`.

```sh
helm install stralforsmcp ./charts/stralforsmcp --set image.tag=<release-tag> \
  --set 'profiles[0].id=example-profile' --set 'profiles[0].country=<cc>' \
  --set 'profiles[0].secretName=example-profile-creds' --set tokenList.secretName=example-token-list \
  --set 'extraHostnames[0]=<mcp-hostname>'
```

Helm must be installed to run `test/chart.test.ts` locally (it renders the chart with `helm template`); CI runners have it.

## Claude Desktop extension

Claude Desktop cannot send a per-user bearer token to a private server on its own, so `extension/` is a small stdio-to-HTTP proxy packaged as a Desktop extension. Claude Code and Cursor need no extension: they send the header themselves (see the `.mcp.json` example under "Running").

1. `npm run mcpb:build` writes `dist/stralforsmcp.mcpb` (unsigned; signing and distribution come in Phase 6).
2. Open the file in Claude Desktop (Settings > Extensions) and fill in two fields:
   - **Server URL**: the `https://` address of the server, for example `https://<mcp-hostname>/mcp`. Plain `http://` is accepted only for localhost.
   - **Personal token**: your `smcp_` token. Desktop keeps it in the operating system secure store and passes it to the proxy by environment variable.
3. A 401 or authorization error means the token is wrong, revoked or expired: ask the server operator for a new one.

The bridge forwards MCP messages unchanged; see [extension/README.md](extension/README.md) and ADR 0015.

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

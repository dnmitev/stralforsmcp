# Stralfors MCP

Vocabulary of this server and of the Stralfors Output Management API as seen through it. Terms carry the code identifier in parentheses where one exists.

## Environment and credentials

**Environment** (`Config.env`):
The API deployment a client talks to: `test` or `prod`. Each has a fixed base URL that no configuration can change.
_Avoid_: stage, mode, NODE_ENV

**Credential profile** (`Profile`, env prefix `STRALFORS_PROFILE_<ID>_`):
One identity against the API: OAuth client id and secret, client certificate and key (optionally passphrase-protected), a country code and zero or more agreement ids. Identified by a free-form profile id; "profile" is the accepted short form.
_Avoid_: account, tenant, client config

**Profile id** (`Profile.id`):
The caller-chosen name of a credential profile. The only identity that may appear in logs and error messages.

**Secret file** (`*_FILE` variables):
A file whose content is a secret value. Secrets reach the client only as file paths, never as literal values.

## Agreements, channels and documents

**Agreement id** (`actionId` on the wire, `Profile.agreements[].id`):
The UUID that selects one customer contract on the API side. Required for validation and sending; optional when listing channels. The name `actionId` is used only where it crosses the wire.
_Avoid_: action id, contract id, GUID (unqualified)

**Agreement label** (`Profile.agreements[].label`):
A human name given to an agreement id in configuration so reports and logs can refer to the agreement without exposing the id. The only agreement handle a tool accepts or returns; the server maps the label to the id.
_Avoid_: profile label

**Channel**:
A delivery route for a document, named by the API as a string (`eInvoice`, `EDI`, `Kivra`, ...). The set of names the client knows at build time is `KNOWN_CHANNELS`; the API may return others.

**Client catalogue** (`channels()` without an agreement id):
The channels enabled for the credential profile as a whole. Wider than any single agreement allows.
_Avoid_: bare list, client channels, all channels

**Agreement channels** (`channels(actionId)`):
The channels one agreement may actually use. The authoritative answer for "which channels can this contract send on".
_Avoid_: contract view, contract channels

**Template** (`templates()`, `templateStandardId`):
A layout the API applies to a document, identified by a numeric standard id. Rules depend on the channel and may depend on the template.

**Rule** (`rules()`, `Rule`):
One validation requirement the API publishes for a channel: a parameter path, criteria text, optional pattern and example, and optional dependent rules.

**Document example** (`documentExample()`):
A reference payload the API generates for a set of channels, used as a starting point for a valid document.

**Consignment id** (`consignmentId`):
A caller-supplied idempotency key for one document, 10 to 50 characters, unique per agreement. A repeat is answered with a conflict.
_Avoid_: correlation id, batch id, run id

**Dry run** (`validateInvoice()`, `PUT .../validate?test=true`):
A validation request that is checked by the API as if it were a send but creates nothing. The client can only issue dry runs; there is no way to turn the test flag off from this code.
_Avoid_: validate (ambiguous with local schema validation), test send, simulation

## Responses and errors

**Double-encoded response** (`unwrap`):
A JSON body the API returns as a JSON string that itself contains the JSON object. The client unwraps it before validation; both the plain and the wrapped form are accepted.

**ErrorResponse**:
The API's own error body: a free-text `message` and an optional `compositeFault`. Used for agreement-not-found (404), validation failures (400) and conflicts (409).

**ProblemDetails**:
The framework-level error body (`application/problem+json`) with a `traceId` and per-field `errors`. Means the request was malformed before it reached the API's own logic.

**Route 404** (`RouteNotFoundError`):
A plain-text 404 from the API gateway for a path that does not exist. A deployment or configuration problem, unrelated to any agreement.
_Avoid_: gateway 404, unknown route

**Fault** (`ValidationFailedError.faults`):
One raw entry of `compositeFault.faults` as the API sent it. Kept for diagnosis, never shown or serialised by default.

**Violation** (`Violation`):
The client's parsed view of one fault: rule id, tag, parameter path and the list of criteria that failed. The unit a user-facing message is built from.
_Avoid_: fault (when the parsed form is meant), issue, error item

**Error kind** (`StralforsError.kind`):
The stable, machine-readable classification of a failure (`auth`, `agreement_not_found`, `write_blocked`, ...). A closed literal union (`StralforsErrorKind`) from which the audit reason is derived. Consumers branch on the kind, never on message text.

**Vendor trace id** (`traceId`, `StralforsError.traceId`):
The identifier the API or its framework attaches to a failed request, surfaced for support tickets and audited as-is. Not this server's trace id.
_Avoid_: trace_id (that is this server's OpenTelemetry trace id), request id

## Safety

**Write guard** (`isAllowed`, `WriteBlockedError`):
The fail-closed check applied to every outgoing request before any socket or token is used. In `prod` only listed reads (and the dry run when explicitly enabled) pass; in `test` writes pass only when writes are enabled.
_Avoid_: prod write guard (it acts in both environments), allowlist (unqualified)

**Prod read allowlist** (`PROD_READS`):
The fixed set of read paths the write guard lets through in `prod`.

**Path guard**:
The check that a request path stays under the API's own prefixes and never leaves the fixed base URL.

**Log key allowlist** (`createLogger`, `droppedKeys`):
The fixed set of field names a log line may carry. Any other field is dropped and counted, so a new field cannot leak by accident. It governs what call sites pass, not what the log mixin adds.

**Safe message** (`StralforsError.message`):
An error message made of fixed text only: it never contains header values, body text, secrets or identity ids.

## Tokens

**Token source** (`TokenSource`):
The per-profile supplier of access tokens: fetches, caches, refreshes ahead of expiry and invalidates on an unauthorised answer.

**Single flight** (`inflight`):
The rule that concurrent callers waiting for a token share one upstream request instead of each fetching their own.

**Claims** (`Claims`):
The decoded, unverified payload of an access token, exposing scopes, expiry and audience. The raw payload stays private.

**Scope** (`Claims.scopes`):
A permission the API grants to a credential profile, fixed per client and read from the token, never requested. A write tool implicitly requires `apiomni.write`.

**Proven agent** (`proven`):
A connection agent that has received at least one HTTP response. Before that point a reset connection is treated as a TLS rejection; after it, as a network fault.

## Access and audit

**Access token** (`smcp_` prefix, `TOKEN_RE`):
The per-user bearer secret a client presents to this server: 32 random bytes, base64url, with a detectable prefix. Stored only as its digest.
_Avoid_: API key, session, password

**Token digest** (`hashToken`, `tokens[].hash`):
The SHA-256 hex of an access token; the only form the server stores or compares.
_Avoid_: hash (unqualified), token id

**Token list** (`TokenList`):
The mounted file of users and token digests, re-read on an interval; an invalid file never replaces the last good one.
_Avoid_: user database, token store (the store is the in-memory view of the list)

**Token store** (`TokenStore`, `createTokenStore`):
The in-memory view of the token list that verifies tokens and reloads the list.

**Principal** (`Principal`):
The verified identity behind a call: user id, display name, role and permitted environments. Never the token.
_Avoid_: user (when the token has not been verified), session

**Role** (`Role`):
`dev`, `qa` or `pm`; the coarse permission class of a principal. Only `dev` may use `prod`.
_Avoid_: group, permission

**Verify code** (`VerifyCode`):
The internal reason a token was refused: `malformed`, `unknown`, `expired` or `revoked`. Reaches the audit event, never the caller.

**Access level** (`ToolSpec.access`, `Access`):
What a tool may do upstream: `read`, `validate` (the dry run) or `write`. The policy decides on this, never on the tool name.
_Avoid_: permission, verb, method

**Tool spec** (`ToolSpec`):
The static description of a tool the policy needs: name, access level and an optional required scope.

**Decision** (`decide`, `Decision`):
The pure result of role, environment and scope checks for one principal and one tool; a denial carries exactly one reason code (`env`, `role`, `write`, `scope`).
_Avoid_: authorization (ambiguous with the header), check

**Tool visibility** (`visibleTools`):
The rule that a tool a principal may not call is not listed to that principal.

**Audit event** (`AuditEvent`, `log.type = audit`):
One line per tool call outcome, or per refused authentication, carrying identity, outcome codes, duration and the API trace id; it has no field for arguments, payloads, agreement ids or consignment ids. The reason is a closed union, never free text.
_Avoid_: access log, trace

**Reason** (`AuditReason`):
The closed set of codes an audit event may carry as its reason: a policy deny reason, a verify code, a Stralfors error kind, `write_guard`, `bad_input` or `error`. Derived from the error kind union, so a new kind is a new reason without a second list. `rate_limited` names both this server's own limit (outcome `denied`, tool `-`) and the upstream 429 (outcome `error`). The type rejects any other string. Also the only values the span attribute and metric label `error.type` may take.
_Avoid_: message, detail, cause (free text)

**Outcome** (`Outcome`):
`allowed`, `denied`, `blocked` (stopped by the write guard) or `error` (upstream or client failure).

**Masked identifier** (`mask`):
An identifier shown as its first and last four characters; anything shorter than sixteen characters is shown as "…" only.

**Authentication** (`authenticate`):
Turning the Authorization header of one request into a principal through the token store, before the request reaches the MCP handler. Anything that is not exactly `Bearer <token>` is treated as a malformed token.
_Avoid_: login, sign-in, authorization (that is the policy decision)

**Authentication result** (`AuthResult`):
Either a principal wrapped for the MCP handler or a verify code; the only thing the HTTP layer learns from the Authorization header. A refusal is answered with one fixed 401 whatever the cause.

**Transport guard** (`refuse`, Host and Origin validation):
A check on the raw request before authentication: Host, Origin, path, method and declared body size. A refusal (403, 404, 405, 413) carries no identity and is not an audit event.
_Avoid_: middleware, filter, firewall

**Liveness** (`/healthz`):
The answer "the process runs"; always 200 while it does.

**Readiness** (`/readyz`):
The answer "this instance accepts work"; 200 until shutdown begins, 503 from then on so a load balancer stops routing to it.
_Avoid_: health (ambiguous between the two)

## Server

**Factory** (`buildMcp`, `McpServerFactory`):
The function the MCP handler calls once per request to build a fresh MCP server holding only the caller's visible tools. Without a principal it builds a server with no tools.
_Avoid_: singleton, shared server, session server

**Per-caller tools** (`registerAll`, `visibleTools`):
The property that the tool list a caller sees is computed for that caller at request time; a tool the caller may not use is absent, and calling it is an unknown-tool protocol error rather than a denial.
_Avoid_: hidden tools, disabled tools

**Tool definition** (`ToolDef`):
A tool spec plus title, description, input and output schemas, annotations and the function that does the work. The static, policy-free description of one tool.
_Avoid_: handler (that is only the function inside), command

**Registry** (`registerAll`, `callTool`):
The only path from a tool definition to a tool the MCP server exposes. Every call passes through its wrapper: policy re-check, one audit event, sanitised errors. Calls the SDK rejects for schema-invalid arguments never reach the wrapper and produce no audit event.
_Avoid_: router, dispatcher

**Sanitised tool error** (`DENIED_TEXT`, `ERROR_TEXT`):
The only two error texts a tool call returns to a client: `not allowed: <code>` for a policy denial and `tool failed` for anything thrown. The thrown message never reaches the client.
_Avoid_: error message (unqualified), stack

**Era** (`ctx.era`):
The MCP protocol generation a request speaks: `modern` (the 2026-07-28 envelope) or `legacy` (the 2025 initialize handshake). Both are served from the same endpoint, both statelessly.
_Avoid_: version (ambiguous with the server version), mode

**Stateless**:
The server issues and accepts no session id; every request carries its own token and any replica can answer it.
_Avoid_: session, sticky, connection (for a client relationship)

**Drain** (`drainMs`):
The bounded wait during shutdown for requests already in flight to finish after the listener has closed and readiness has gone to 503.
_Avoid_: graceful shutdown (the whole sequence), timeout (unqualified)

**Client per profile** (`clients`, keyed by profile id):
One Stralfors client (connection agent and token source) per credential profile, created before the server listens and closed after the drain. Tools look a client up by profile id; a tool with one configured profile may default to it.
_Avoid_: connection, session, per-request client

**Principal context** (`withPrincipal`, `currentPrincipal`):
The async-local scope that carries the calling principal through one tool call, so code the tool reaches indirectly (the client's blocked-write hook) can attribute its audit event. Empty outside a tool call.
_Avoid_: thread-local, global user, request context

**Tool input error** (`ToolInputError`, reason `bad_input`):
A tool refusing its own arguments with a fixed text before any upstream call: a missing or unknown profile, an unknown agreement label.
_Avoid_: validation error (that is the SDK's schema check or the upstream dry run), bad request

**Rate limit** (`createRateLimiter`, `MCP_RATE_PER_MINUTE`, `MCP_RATE_BURST`):
A token bucket per authenticated principal held in the memory of one process: `perMinute` refill, `burst` capacity. A refusal is a 429 with `Retry-After` in whole seconds and an audit event with reason `rate_limited` and tool `-`.
_Avoid_: throttling (the upstream 429), quota

**Bucket**:
The per-principal state of the rate limit: its remaining tokens and the time of its last use. A bucket that has been full and idle for a whole refill period is forgotten, so the number of buckets never exceeds the number of users in the token list.

**Burst** (`burst`):
The number of calls a principal may make at once from a full bucket before the per-minute rate applies.

**Staleness** (`staleMs`, `MCP_TOKEN_STALE_MS`, `token_list.stale`):
How long the token list has been served from its last good load while reloads keep failing; zero while the last reload succeeded. Past the threshold one fixed warning is written; it is never a readiness condition. Exported as the gauge `mcp_token_list_stale_seconds`.
_Avoid_: expiry, outage, unhealthy

**Whoami** (`whoami`):
The read tool that returns the caller's name, role and permitted environments, the deployment environment, the tools visible to the caller and the configured profiles (id and country). Never a token, scope, secret or agreement id.

## Observability

**Manual instrumentation**:
The rule that every span and metric comes from explicit code in this repository: no auto-instrumentation package, no loader hook, no `traceparent` sent to the API.
_Avoid_: agent, auto-instrumentation, plug-in

**Span** (`withSpan`):
One timed unit of work with a fixed name, a kind and attributes drawn from the span key allowlist. This server creates exactly three kinds: the root server span, the tool span and the upstream span. A failure sets status `ERROR` and `error.type`; it never records an exception or a message.
_Avoid_: trace (the tree of spans), event, log

**Root server span** (`POST /mcp`, kind `SERVER`):
The span around one request on the MCP port after the transport guards; always a root, because the incoming `traceparent` and `tracestate` are ignored. Health probes and guard refusals have no span. A 401 or 429 leaves the status unset but carries `error.type`.
_Avoid_: request span (ambiguous with the upstream span), trace

**Tool span** (`mcp.tool <name>`, kind `INTERNAL`):
The span around one tool call through the registry, a child of the root server span, carrying the tool name, environment, outcome and reason.

**Upstream span** (`stralfors.request`, kind `CLIENT`):
The span around one request to the API, created by the instrument hook, carrying the operation and method and, on failure, the status code and error kind. It never carries a path, query, id or URL.
_Avoid_: client span (ambiguous with the MCP client), vendor span

**Span key allowlist** (`ALLOWED_SPAN_KEYS`, `setSafe`, `droppedKeys`):
The closed set of attribute keys any span may carry. Attributes set through `setSafe` with another key are dropped and counted; attributes set on the span directly are not covered.
_Avoid_: scrubber, redaction

**Instrument** (`INSTRUMENTS`):
One named metric with a kind (counter, histogram, observable gauge), a unit, a description and its label keys. The unit is exported as a `# UNIT` line, never as a name suffix.
_Avoid_: metric series, label set (that is the output), gauge (unqualified)

**Instrument table** (`INSTRUMENTS`):
The single table that defines every instrument together with its label keys, so the label allowlist and the call sites cannot drift apart. An instrument not in the table has no allowlist.

**Structural label allowlist** (allowlist View, `createAllowListAttributesProcessor`):
One per-instrument View that drops any label not in the instrument's key list before aggregation, so the set of label keys is bounded by the table and not by call-site discipline. It bounds keys, not values.
_Avoid_: filter, scrubber, cardinality limit (that would bound values)

**Method label** (`METHOD_LABEL`, `_OTHER`):
The HTTP method as a label or attribute: one of the nine standard methods verbatim, anything else `_OTHER`, so caller text never becomes a label value.

**Route label** (`http.route`):
The fixed template `/mcp` on every measured request on the MCP port, whatever the path was. Never the request path.

**Trace id and span id** (`trace_id`, `span_id`, `activeIds`):
The 32- and 16-hex identifiers of the active span, copied onto log lines and, the trace id only, onto audit lines, sampled or not. They correlate lines of one request and are never a metric label. Not secret, not an identity.
_Avoid_: traceId (the vendor trace id), request id, correlation id

**Log mixin** (`logMixin`):
The function that adds `trace_id` and `span_id` to every log line written inside a span. It runs after the log key allowlist, so it is the one path that can add keys the allowlist does not see.

**Metrics listener** (`MCP_METRICS_HOST`, `MCP_METRICS_PORT`, `GET /metrics`):
A second plain HTTP listener owned by the server that answers only `GET /metrics` in Prometheus text format and 404 to everything else. It has no guards, authentication or TLS and is meant to be reachable from the scraper only; the MCP port answers 404 for `/metrics`.
_Avoid_: admin port, management port, exporter server (the library's own server is never started)

**Sample ratio** (`MCP_TRACE_SAMPLE_RATIO`, `TraceIdRatioBasedSampler`):
The fraction of root spans that are recorded and exported, decided here and only here; a caller cannot raise it or choose ids. An unsampled span still has valid ids for correlation.
_Avoid_: trace rate, sampling header

**Trace exporter** (`OTEL_EXPORTER_OTLP_ENDPOINT`):
The optional OTLP/HTTP destination for spans. Without it spans are created but never exported; with it, export failures are swallowed and never affect readiness.

**Instrument hook** (`instrument`, `InstrumentInfo`):
The client's seam that wraps one upstream request, after the write guard and around the token fetch and retry, with only an operation name and a method. It keeps the client library free of telemetry imports.
_Avoid_: middleware, interceptor

**Telemetry shutdown bound** (`TELEMETRY_FLUSH_MS`):
The fixed time shutdown waits for exporters to flush before giving up and reporting a failed close. The only observable failure of telemetry shutdown is time.
_Avoid_: flush timeout (unqualified), drain (that is the HTTP wait)

**Context manager ownership** (`shared`, `owners`):
The rule that the process has one async-local context manager, registered globally by the first telemetry created and disabled by the last one shut down. The tracer and meter providers are never registered globally.
_Avoid_: global tracer, global SDK

## Container image

**Image** (`Dockerfile`):
The OCI image that packages the server: a distroless Node 26 `nonroot` base, the repository's `src/` run through Node's native type stripping, and production dependencies only. It carries no shell, no package manager, no build output and no configuration value.
_Avoid_: container (a running instance), bundle, dist

**Base image digest** (`@sha256:` in each `FROM`):
The index digest pinned after `@` in a `FROM` line. The tag beside it is for readability; the digest decides the bytes. Bumped by hand in a reviewed pull request.
_Avoid_: version, floating tag

**Build stage** (`deps`):
The throwaway `node:26-trixie-slim` stage that installs production dependencies on the build platform. Only its `node_modules` reaches the final stage.
_Avoid_: builder image, compile stage (nothing is compiled)

**Final stage**:
The distroless stage whose contents are the image: `node_modules` from the build stage, `package.json` and `src/`, owned by uid 65532, started by the base image's `node` entrypoint with `src/server/main.ts`.
_Avoid_: runtime image, production stage

**Type stripping**:
Node's native execution of TypeScript source with type annotations removed at load time, so the image runs the reviewed `src/` files themselves. Requires Node 24.12 or later (`engines.node`).
_Avoid_: transpile, compile, build

**Smoke test** (`scripts/image-smoke.ts`):
The check that starts a built image read-only, non-root and with all capabilities dropped, against a throwaway fixture, and verifies the Node major, liveness, metrics, the fixed 401 and a clean SIGTERM exit from outside the container.
_Avoid_: integration test, e2e

**Image content check** (`Image content` step):
The workflow step that lists the image's files and fails when tests, scripts, docs, lock files, credentials, a shell or npm appear outside `node_modules`.
_Avoid_: content scan, audit

**Gate** (`Gate (fixable HIGH/CRITICAL)`, `Dockerfile config`):
The Trivy scans that fail the workflow on a fixable HIGH or CRITICAL vulnerability in the image or a HIGH or CRITICAL misconfiguration in the `Dockerfile`. Unfixed vulnerabilities are reported, not gating.
_Avoid_: audit, compliance check

**Ignore file** (`.trivyignore.yaml`):
The only place a gate finding can be excepted. Every entry carries a `statement` and an `expired_at` date at most 90 days ahead; a lapsed entry makes the gate fail again.
_Avoid_: allowlist, suppression

**SBOM** (`sbom.cdx.json`, `sbom: true`):
The component inventory of the image. Two forms exist: a CycloneDX file Trivy writes as a workflow artifact on every run, and the SPDX attestation BuildKit attaches to the published image index.
_Avoid_: manifest (the OCI manifest), dependency list

**Provenance** (`provenance: mode=max`):
The SLSA build attestation BuildKit attaches to the published image index, stating which workflow, commit and inputs produced it. It is not a signature.
_Avoid_: signature, certificate

**Build-scan job** (`build-scan`):
The workflow job that runs on every event with read permission only: builds linux/amd64, runs the image content check, the smoke test and the gates, and uploads the `image-sbom-and-scan` artifact. Nothing is pushed.
_Avoid_: CI build, test job

**Publish job** (`publish`):
The only workflow job with `packages: write`. Runs after a green build-scan on a push to `main` or a `v*` tag of this repository, never on a pull request or a fork, logs in to GHCR with the workflow token and pushes a fresh linux/amd64 and linux/arm64 build.
_Avoid_: release job, deploy

**Tag policy**:
`sha-<40 hex commit>` on every publish, `edge` on `main`, `X.Y.Z`, `X.Y` and `latest` on `v*` release tags only. Deployments reference a digest or an immutable tag.
_Avoid_: `latest` or `edge` for deployments

**Pin bump**:
The manual, reviewed pull request that moves a base image digest, the Trivy version and checksum, or an action commit SHA. No update bot does this yet.
_Avoid_: upgrade, auto-update

## Quality

**Mutation score**:
The share of deliberately injected code changes that the test suite detects. Core client modules target 80 %; the build fails below 70 %.

**Confidence status** (`review/confidence`):
The commit status the principal review publishes: how confident the review is that the exact head commit adds no defect, security issue or leak. A pull request merges only above the agreed threshold.

**Synthetic fixture**:
Test data written by hand in the shape the API uses, with placeholder values and nil ids. Never a copy of a vendor or customer payload.

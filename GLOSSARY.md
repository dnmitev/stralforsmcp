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

**Trace id** (`StralforsError.traceId`):
The identifier the API or its framework attaches to a failed request, surfaced for support tickets.

## Safety

**Write guard** (`isAllowed`, `WriteBlockedError`):
The fail-closed check applied to every outgoing request before any socket or token is used. In `prod` only listed reads (and the dry run when explicitly enabled) pass; in `test` writes pass only when writes are enabled.
_Avoid_: prod write guard (it acts in both environments), allowlist (unqualified)

**Prod read allowlist** (`PROD_READS`):
The fixed set of read paths the write guard lets through in `prod`.

**Path guard**:
The check that a request path stays under the API's own prefixes and never leaves the fixed base URL.

**Log key allowlist** (`createLogger`, `droppedKeys`):
The fixed set of field names a log line may carry. Any other field is dropped and counted, so a new field cannot leak by accident.

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
The closed set of codes an audit event may carry as its reason: a policy deny reason, a verify code, a Stralfors error kind, `write_guard`, `bad_input` or `error`. Derived from the error kind union, so a new kind is a new reason without a second list. `rate_limited` names both this server's own limit (outcome `denied`, tool `-`) and the upstream 429 (outcome `error`). The type rejects any other string.
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
How long the token list has been served from its last good load while reloads keep failing; zero while the last reload succeeded. Past the threshold one fixed warning is written; it is never a readiness condition.
_Avoid_: expiry, outage, unhealthy

**Whoami** (`whoami`):
The read tool that returns the caller's name, role and permitted environments, the deployment environment, the tools visible to the caller and the configured profiles (id and country). Never a token, scope, secret or agreement id.

## Quality

**Mutation score**:
The share of deliberately injected code changes that the test suite detects. Core client modules target 80 %; the build fails below 70 %.

**Confidence status** (`review/confidence`):
The commit status the principal review publishes: how confident the review is that the exact head commit adds no defect, security issue or leak. A pull request merges only above the agreed threshold.

**Synthetic fixture**:
Test data written by hand in the shape the API uses, with placeholder values and nil ids. Never a copy of a vendor or customer payload.

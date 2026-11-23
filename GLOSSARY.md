# Stralfors MCP

Vocabulary of this server and of the Stralfors Output Management API as seen through it. Terms carry the code identifier in parentheses where one exists.

## Environment and credentials

**Environment** (`Env`, `test` | `prod`):
One of the two Stralfors API deployments. Each has a fixed base URL that no configuration can change. The word is used on two sides: the deployment environment of a server instance and the permitted environments of a principal; a tool call needs the former to be among the latter.
_Avoid_: stage, mode, NODE_ENV

**Deployment environment** (`STRALFORS_ENV`, `Config.env`, `deploy`, chart `stralfors.env`):
The one environment a running server instance and all its clients talk to, fixed at start and reported by `whoami`. Never changed by a request.
_Avoid_: current env, target, server mode

**Permitted environments** (`Principal.envs`, `users[].envs`):
The environments a principal may use, taken from the token list. The list may name `prod` for any role, but the decision denies a call in `prod` unless the role is `dev`: only a `dev` may use `prod`.
_Avoid_: allowed envs, access list

**Credential profile** (`Profile`, env prefix `STRALFORS_PROFILE_<ID>_`):
One identity against the API: OAuth client id and secret, client certificate and key (optionally passphrase-protected), a country code and zero or more agreement ids. Identified by a free-form profile id; "profile" is the accepted short form.
_Avoid_: account, tenant, client config

**Profile id** (`Profile.id`):
The caller-chosen name of a credential profile. The only identity that may appear in logs and error messages.

**Secret file** (`*_FILE` variables):
A file whose content is a secret value. Secrets reach the client only as file paths, never as literal values. The certificate, key and passphrase files are re-read while the server runs (credential hot-swap); the client id and secret files are read once at start.

**Credential hot-swap** (`reloadCredentials`, `STRALFORS_CERT_RELOAD_S`):
The rule that each client re-reads its certificate, key and passphrase files on a fixed interval and, when the content changed and loads, switches to a new connection agent while requests in flight finish on the old one. Content is compared, not file times, so an identical rewrite is not a change.
_Avoid_: rotation (the operator's act of replacing the files), reload (ambiguous with the token list), watch

**Reload failure kind** (`credentials.reload_failed`, `kind`):
The closed reason a hot-swap tick kept the last good agent: `read`, `empty`, `pem` or `key`. Logged once per distinct kind until a tick succeeds, with the profile id and nothing else.

**Last good**:
The rule shared by the token list and the credential hot-swap: a reload that fails or yields invalid material changes nothing, and the material in use stays until a later reload succeeds. Never a readiness condition.
_Avoid_: fallback, cache, stale copy

## Agreements, channels and documents

**Agreement id** (`actionId` on the wire, `Profile.agreements[].id`):
The UUID that selects one customer contract on the API side. Required for validation and sending; optional when listing channels. The name `actionId` is used only where it crosses the wire.
_Avoid_: action id, contract id, GUID (unqualified)

**Agreement label** (`Profile.agreements[].label`):
A human name given to an agreement id in configuration so reports and logs can refer to the agreement without exposing the id. The only agreement handle a tool accepts or returns; the server maps the label to the id.
_Avoid_: profile label

**Channel**:
A delivery route for a document (`eInvoice`, `EDI`, `Kivra`, ...). The vendor can add new ones at any time.
_Avoid_: channel (unqualified) when a lookup channel or tracking channel is also meant; say delivery channel then

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

**Criterion** (`ruleCriterias[]`, `parseCriterion()`):
One requirement text of a rule, such as "required", "one of these values" or "must match a pattern". Parsed into a criterion kind and parameters; text the parser does not know becomes the `unknown` kind.

**Rule pattern** (`pattern` criterion, `expectedPattern`):
A regular expression a rule publishes for a value. It follows the vendor's own regular-expression dialect, which this server cannot always interpret; such a pattern never produces a local finding and only the dry run decides.
_Avoid_: regex (unqualified), format

**Pattern dialect**:
Rule patterns are written for the vendor's .NET regular-expression engine, not JavaScript's. A pattern using syntax the two engines read differently, or a value they would judge differently, is left to the dry run instead of being checked locally.
_Avoid_: regex flavour; invalid pattern (the drift finding `pattern-not-compilable` is a different thing)

**Criterion kind** (`Criterion.kind`):
The fixed token for a criterion (`required`, `valid_items`, `pattern`, ...). Each kind has one fixed sentence template, so callers read the same wording whatever the vendor text says.

**Hint** (`ReadableRule.hints`, `hintFor()`):
The plain-language sentence a criterion kind produces for a path. Hints are fixed templates filled with parsed parameters; vendor messages and exception text never appear in one (ADR 0016).

**Flattened rule** (`flattenRules()`, `ReadableRule`):
A rule with its JSON path in camelCase (`[]` kept), a required flag, hints and an optional `dependsOn`. Child rules of a dependency become entries of their own, so the rule count includes them.

**Rules cache** (`createRulesCache`, `MCP_RULES_CACHE_S`):
Per-pod cache of a channel's flattened rules, keyed by profile, channel and template. A pending fetch is shared by every caller; the TTL starts when it settles; the oldest settled entries are evicted at 256.

**Finding** (`Finding`, `findings.ts`):
One reported problem in a validation result: source (local or Stralfors), rule id, JSON path, criterion kind, a fixed sentence and, where published, the expected pattern and an example value. Vendor message text is never part of a finding.

**Local check** (`localCheck()`):
The second validation stage: the cached rules are interpreted against the document without calling the API. It reports only what it is certain of; a rule whose ancestor is absent, or that is conditional, is left to the dry run. Its findings stop the dry run only when the document lists exactly one channel and that channel's rules were fetched at most 5 minutes ago; otherwise the dry run decides.

**Validation stage** (`input`, `local`, `dry_run`, `passed`):
The step that produced a validation result's findings. Stages run in that order and stop at the first one with findings.

**Document example** (`documentExample()`):
A reference payload the API generates for a set of channels, used as a starting point for a valid document.

**Consignment id** (`consignmentId`):
A caller-supplied idempotency key for one document, 10 to 50 characters, unique per agreement. A repeat is answered with a conflict.
_Avoid_: batch id, run id; "correlation id" (that is the lookup handle, a different thing)

**Dry run** (`validateInvoice()`, `PUT .../validate?test=true`):
A validation request that is checked by the API as if it were a send but creates nothing. It is the authority: a document is valid only when the dry run accepts it. The client can only issue dry runs; there is no way to turn the test flag off from this code.
_Avoid_: validate (ambiguous with local schema validation), test send, simulation

**Outcome** (`Outcome`, `channelOutcome()`, `documentOutcome()`):
Our own five-value reading of a tracking status: `delivered`, `in_progress`, `refused`, `failed` or `unknown`. A fixed mapping of the raw status strings, which are always returned beside it; a status the table does not know is `unknown`. A document's outcome is derived from its channels (any delivered wins, then in progress, then unknown, then refused, then failed). An unknown status is never shown as progress or as final.
_Avoid_: state, result

**Tracking channel** (Track & Trace `channelId`, `channelName`):
A delivery route as the tracking system names it, with its own numeric ids and names, different from the `Channel` names of the Omni API. A document can have several, each with its own status.
_Avoid_: channel (unqualified) when both vocabularies appear

**Tracking document id** (`documentId` in `track_document`):
The tracking system's identifier of one document: alphanumeric, at most 10 characters, assigned after sending and never returned by the send. Not the `guid` that a dry run echoes.
_Avoid_: guid, consignment id

## Channel lookup

**Channel lookup** (`channel_lookup`, Channel Lookup API):
An asynchronous question to the vendor: which lookup channels can reach each of a few candidate recipients. A start request returns a correlation id; a later read returns the completed answer. TEST only in this server.
_Avoid_: channel check, recipient search

**Lookup channel** (`channels` of `channel_lookup`):
A channel name in the Channel Lookup API's own vocabulary (`Kivra`, `eInvoiceB2C`, `eInvoiceB2B`, `Billo`, ...). Configured per client and independent of the agreement's delivery channels: having a delivery channel does not imply its lookup channel.
_Avoid_: channel (unqualified), delivery channel

**Candidate**:
A recipient identifier submitted to a channel lookup, such as a personal or organisation number. Personal data: it travels only in the request body and is never logged, audited, echoed or returned.
_Avoid_: recipient, customer, subject

**Matched candidate** (`matchedCandidates`):
A candidate the vendor lists as reachable in a lookup channel. The vendor answers with matches only; a candidate that is absent is not reachable there, and the answer has no per-candidate yes or no.
_Avoid_: hit, result

**Availability** (`available[]`):
This server's per-candidate yes or no for one lookup channel, derived by matching normalised candidates against the matched candidates, in the order the candidates were given.

**Unrecognised count** (`unrecognised`):
The number of matched candidates that fit none of the submitted candidates after normalisation. Shows a spelling mismatch without showing any value.

**Lookup failure reason** (`reason`: `not_configured` | `error`):
Why a lookup channel has no availability: `not_configured` when the vendor says the channel is not set up for this client, `error` for anything else. A fixed code; the vendor sentence is never returned.

**Lookup budget**:
The single 20-second deadline of one `channel_lookup` call, covering the start request and every poll. When it runs out the request in flight is aborted and the caller is told the lookup is still running (reason `timeout`); a caller cancel inside it stays a caller cancel.
_Avoid_: polling deadline, upstream timeout (that applies to each vendor request)

**Correlation id** (lookup):
The vendor's handle for one started channel lookup, used only to read its answer. Never returned to the caller.
_Avoid_: consignment id, lookup id

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
The fixed set of read paths the write guard lets through in `prod`: the Omni reads in `PROD_READS` and exactly two Track & Trace GET paths (document lookup and one document's history).

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

**Personal token** (`smcp_` prefix, `TOKEN_RE`, `generateToken`):
The per-user bearer secret a client presents to this server: 32 random bytes, base64url, with a detectable prefix. Issued to one person, valid at most 90 days. The server side stores only its digest (the token list); the raw value lives with its holder, for example in the Claude Desktop secure store as a sensitive user config value.
_Avoid_: access token (that is the OAuth token the token source fetches from Stralfors), API key, session, password

**Token digest** (`hashToken`, `tokens[].hash`):
The SHA-256 hex of a personal token; the only form the server stores or compares.
_Avoid_: hash (unqualified), token id

**Token list** (`TokenList`, `MCP_TOKEN_LIST_FILE`):
The mounted file of users and token digests, re-read on an interval under the last-good rule. Written by the operator; never by the server.
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
What a tool may do upstream: `read`, `validate` (the dry run), `lookup` (a channel lookup: TEST only, no write flag needed; a required scope still applies if the tool declares one) or `write`. The policy decides on this, never on the tool name.
_Avoid_: permission, verb, method

**Tool spec** (`ToolSpec`):
The static description of a tool the policy needs: name, access level and an optional required scope.

**Decision** (`decide`, `Decision`):
The pure result of the policy for one principal and one tool: the environment, role, write, validate, lookup and scope rules checked in that fixed order, so a denial carries exactly the first failing reason code (`env`, `role`, `write`, `validate`, `lookup`, `scope`). The validate rule denies a validate-level tool in `prod` unless the prod-validate setting is on. A write in `prod` is denied whatever the role or configuration.
_Avoid_: authorization (ambiguous with the header), check, policy (the module, not its result)

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

**Drain** (`drainMs`, `MCP_DRAIN_MS`):
The bounded wait during shutdown for requests already in flight to finish after the listener has closed and readiness has gone to 503. A pod's termination grace period must be longer than it.
_Avoid_: graceful shutdown (the whole sequence), timeout (unqualified)

**Ready delay** (`MCP_READY_DELAY_MS`):
The wait at the start of shutdown during which readiness already answers 503 but the listener still accepts connections, so requests routed before the load balancer notices are still served. The drain follows it (ADR 0023).
_Avoid_: preStop, grace period (the pod's hard limit)

**Vendor heartbeat** (`MCP_HEARTBEAT_S`, `stralfors.up`):
The periodic per-profile call to the vendor's health read; the gauge is 1 only when every profile's last probe answered `UP`. A signal for operators, never a readiness condition.
_Avoid_: health check (ambiguous with liveness and readiness), ping

**Log stream** (`MCP_LOG_LEVEL`, stderr):
The JSON log lines of the server, written to stderr at or above the configured level. Audit events are a separate stream on stdout that no level setting can silence.
_Avoid_: output (unqualified), console

**Client per profile** (`clients`, keyed by profile id):
One Stralfors client (connection agent, token source and credential hot-swap timer) per credential profile, created before the server listens and closed after the drain. Tools look a client up by profile id; a tool with one configured profile may default to it.
_Avoid_: connection, session, per-request client

**Principal context** (`withPrincipal`, `currentPrincipal`):
The async-local scope that carries the calling principal through one tool call, so code the tool reaches indirectly (the client's blocked-write hook) can attribute its audit event. Empty outside a tool call.
_Avoid_: thread-local, global user, request context

**Abort scope** (`withSignal`, `currentSignal`):
The async-local scope that carries the caller's cancel signal through one tool call, so every upstream request the tool starts is aborted when the MCP request is cancelled or its connection drops (ADR 0026). Empty outside a tool call.
_Avoid_: cancellation token, request context

**Caller cancel** (`CancelledError`, kind and audit reason `cancelled`):
A tool call ended because its caller cancelled or disconnected. The upstream request in flight is aborted and never replayed; for a create the vendor may already have accepted it, so its outcome is unknown rather than failed.
_Avoid_: timeout (the server's own deadline), abort (the mechanism)

**Shared work** (`detached`, `untilAborted`):
Upstream work several callers wait on at once, such as a token refresh or a rules cache fill. It runs outside every caller's abort scope, so a cancel ends only that caller's wait.
_Avoid_: background job

**Upstream cap** (`MCP_UPSTREAM_CONCURRENCY`, `createUpstreamLimit`):
The per-pod ceiling on Stralfors requests in flight at once, shared by every profile's client and not counting token fetches. A request over it is refused at once with kind and audit reason `busy`; nothing waits in a queue (ADR 0025).
_Avoid_: rate limit (per principal, per minute), throttling (the upstream 429), pool

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

## Knowledge

**Knowledge doc** (`KnowledgeDoc`, `knowledge/public/*.md`):
One curated Markdown note about the Stralfors API: a front matter followed by a body. Loaded once at start and fixed for the process lifetime; a public doc is an original summary that links to the vendor documentation, never a copy of vendor text (ADR 0021).
_Avoid_: article, page, vendor doc (that is the upstream documentation)

**Front matter** (`parseDoc`):
The block between the opening and closing `---` lines of a knowledge doc: one `key: value` line each for `id`, `title` and the optional `country`, `channel`, `link`, and a comma-separated `tags` line. Not YAML; any other shape makes the doc invalid.
_Avoid_: YAML header, metadata

**Doc id** (`id`):
The lower-case, hyphenated name that identifies a knowledge doc across sources and in its resource URI. A second doc with the same id in one directory is skipped; an overlay doc with the same id as an earlier one replaces it.
_Avoid_: slug, file name (the file name is not the id)

**Doc source** (`source`: `public` | `private`):
The label on every knowledge doc and search hit saying whether it came from the public corpus or an overlay. Set by where the file was loaded from, never by its front matter.
_Avoid_: origin, visibility; "token source" (the OAuth one)

**General doc** and **scoped doc** (`country`, `channel`):
A general doc has neither `country` nor `channel` and matches any country or channel filter; a scoped doc names one or both and matches only those values. A filter never hides a general doc.
_Avoid_: global doc, default doc

**Public corpus** (`knowledge/public`):
The knowledge docs that ship in the repository and the image. Every one has an `https` link, stays within the length cap and loads without warnings.
_Avoid_: built-in docs, base layer

**Overlay** (`KNOWLEDGE_DIRS`):
One or more operator-mounted directories of knowledge docs layered over the public corpus. Every overlay doc is labelled `private`, a later directory replaces an earlier doc with the same id, and a configured directory that is missing stops start-up. Never committed and never in the image.
_Avoid_: private layer, plugin, extension

**Load warning** (`LoadWarning`):
A file or directory skipped while loading knowledge (unreadable, too large, invalid front matter, a duplicate id within one directory) or the doc limit being reached, tagged with its doc source. The start-up log names skipped public docs by base name and counts private ones only.
_Avoid_: load error (a load never fails on one bad file)

**Search index** (`createIndex`, `Index`):
The in-memory ranking structure built once from the loaded knowledge docs that `search_docs` queries. No network index and no Stralfors client.
_Avoid_: "index" unqualified (clashes with the index resource)

**Search hit** (`Hit`, `snippet`, `total`, `truncated`):
One ranked knowledge doc returned by `search_docs`: id, title, doc source, country, channel, link and a short snippet, never the whole body. `total` counts all matches; `truncated` says more matched than were returned.
_Avoid_: result (the whole response), match

**Reference material**:
The status of any knowledge doc text, search snippet or pasted finding shown to an assistant: data to read, never instructions to follow. Tool and prompt text says so.
_Avoid_: context, instructions

**Resource** (`knowledge://`):
A knowledge doc or the doc list exposed through the MCP resources surface so a client can attach it to a conversation. Read-only, served from the loaded docs without I/O, visible to every authenticated principal and audited as `resource:read`. Live API data is never a resource; it stays in tools.
_Avoid_: attachment, file

**Index resource** (`knowledge://index`):
The single static resource listing every knowledge doc's id, title, doc source, country and channel, without bodies.
_Avoid_: catalogue (that is the client channel catalogue), table of contents

**Doc resource** (`knowledge://docs/{id}`):
The resource template with one resource per knowledge doc. A read returns a Markdown header (title, doc source, country, channel, link) followed by the body. An unknown and an invalid id get the same fixed not-found error, which echoes nothing.
_Avoid_: document resource ("document" is the invoice sent to the API)

**Prompt** (`explain_channel`, `prepare_validation`, `explain_validation_findings`):
A fixed-text guided start a client offers its user, filled with validated arguments only. It tells the assistant which tools to call and to report an unavailable tool instead of guessing; it never calls the API itself. Audited as `prompt:get`. Not file-defined; an overlay cannot add one.
_Avoid_: template (that is the vendor document template), recipe, workflow

**Data fence**:
The fenced block in `explain_validation_findings` that holds the pasted findings, longer than any backtick run inside them and labelled as data, not instructions, so pasted text cannot close it or steer the assistant.
_Avoid_: quote, code block (unqualified)

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
_Avoid_: traceId (the vendor trace id), request id; "correlation id" (that is the lookup handle)

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

**Image signature** (`cosign sign`, keyless):
The keyless Sigstore signature the publish job puts on the image digest it pushed, only after that same digest has passed the gate on both platforms (scan, then sign). It states which workflow and ref built the image, not that it was reviewed.
_Avoid_: provenance (the build attestation), SBOM

**Rescan** (`rescan.yml`):
The weekly read-only re-run of the gate against the published image, catching vulnerabilities disclosed after it was published.
_Avoid_: rebuild, scheduled build

**Tag policy**:
`sha-<40 hex commit>` on every publish, `edge` on `main`, `X.Y.Z`, `X.Y` and `latest` on `v*` release tags only. Deployments reference a digest or an immutable tag.
_Avoid_: `latest` or `edge` for deployments

**Pin bump**:
The reviewed pull request that moves a base image digest, an action commit SHA or an exact npm version. Dependabot opens them weekly, grouped and after a cooldown, and rewrites the exact pin rather than loosening it; the Trivy and cosign binaries are still bumped by hand.
_Avoid_: upgrade, auto-update

## Helm chart

**Chart** (`charts/stralforsmcp`):
The Helm chart that runs the image in Kubernetes: a Deployment, a Service for the MCP port, a separate Service for the metrics port and optional ingresses, pod disruption budget and network policy. The chart is the deployment shape; the cluster, ingress controller and secret tooling are the operator's.
_Avoid_: deployment (the Kubernetes object, or the act of deploying), manifest

**Secret by name** (`secretName`, `secretKeyRef`):
The rule that values carry only the names of Kubernetes Secrets and keys the operator created; the chart has no Secret template and no value that holds a credential.
_Avoid_: inline secret, secret value

**Whole-directory mount**:
The rule that the mounted Secrets (the credential files and the token list) are mounted as directories, never through `subPath`, so a rotated Secret reaches the running pod and the last-good reloads can see it. Secrets injected as environment variables through `secretKeyRef` (`action-ids`, the OTLP headers) are not mounted and need a pod restart (see start-only secret).
_Avoid_: file mount, subPath mount

**Start-only secret** (`action-ids`, OTLP headers, client id and secret):
A secret the server reads once at start, so rotating it needs a pod restart. Everything else in a mounted Secret is picked up live.
_Avoid_: static secret, env secret

**Render guard** (`fail` in `_helpers.tpl`, `values.schema.json`):
A check that makes `helm template` or `helm install` fail before any pod exists: `prod` with writes enabled, `prod` with a public ingress, a grace period not longer than the drain, or no hostname. Only `prod` with writes enabled also has a server-side refusal (the config refuses to start); the public-ingress, grace-period and hostname checks exist in the chart alone, so a deployment that does not use the chart does not get them. Either way a bad value fails at render time, not in a crash loop.
_Avoid_: write guard (the client's), prod guard (unqualified), validation

**Internal and public ingress** (`ingress.internal`, `ingress.public`):
Two optional ingresses with the same shape for the MCP port only. The public one is refused with `prod`; the metrics port is never behind either.
_Avoid_: external ingress, admin ingress

## Desktop extension

**Desktop extension** (`extension/`, `dist/stralforsmcp.mcpb`, `npm run mcpb:build`):
The Claude Desktop package that carries the bridge as one bundled JavaScript file plus a manifest. Needed because Desktop cannot send a per-user bearer token to a private server on its own; Claude Code and Cursor need none.
_Avoid_: connector (Desktop's cloud-called custom connector), plugin, app

**Bundle attestation** (`attest`, `SHA256SUMS`):
The build-provenance attestation a `v*` tag adds to the `.mcpb`, published with a SHA-256 checksum file. The bundle build is reproducible, so two builds of one commit have the same checksum.
_Avoid_: signature (that is the image's), notarisation

**Bridge** (`extension/src/proxy.ts`, stderr prefix `stralforsmcp-bridge`):
The local process the extension starts: stdio towards Desktop, Streamable HTTP towards the hosted server, forwarding MCP messages verbatim and adding only the `Authorization` header. stdout carries protocol frames only; stderr carries a few fixed lines that never contain the token, the URL or upstream text. A 401 ends it with the fixed text `authorization failed (check your token)`.
_Avoid_: proxy (the file name only), client, server (it is neither to the user)

**User config** (`user_config`, `MCP_URL`, `MCP_TOKEN`):
The two values Desktop asks for at install: the server URL and the personal token. The token is marked sensitive, kept in the operating system secure store and handed to the bridge by environment variable, never on the command line.
_Avoid_: settings, credentials (the Stralfors ones)

**Loopback exception** (`localhost`, `127.0.0.1`, `[::1]`):
The one case in which plain `http://` is accepted where a secret would travel: the bridge's server URL and the OTLP endpoint when headers are set. Any other host must be `https://`.
_Avoid_: dev mode, insecure flag

## Local development

**Dev env file** (`.env.local`, template `.env.example`):
The git-ignored file `npm run dev` loads: settings and file paths only, never a secret value or a token.
_Avoid_: dotenv, config file (unqualified)

**Dev token** (`npm run dev:token`, `scripts/dev-token.ts`):
A personal token for one local user (`dev`, role `dev`, environment `test`, 30 days) written as a fresh token list with only the digest in the file; the raw token is shown once on stderr. Never used against a hosted server.
_Avoid_: test token, default token

## Live and contract checks

**Drift check**:
A manual, read-only comparison of what one environment's API publishes (version, channels, templates, rules) with what this server's code understands. Its output is counts per check name, never vendor text.
_Avoid_: drift test, contract test, monitoring

**Drift finding** (`unknown-criterion`, `pattern-not-compilable`, `channel-new`, ...):
One check name with a count from a drift check. Distinct from a validation finding.

**Drift baseline** (`baseline-<env>.json`):
The private record of a previous drift check (names, ids, version, counts and hashes of free-text criteria) that later runs compare against.

**Standing finding**:
A drift finding that is present on every run against the live API (unknown criterion kinds, rule patterns this server cannot interpret). With a baseline it counts as drift only when its count changes.

**Live read check**:
A manual run of the read tools against a real environment that prints shapes and counts only, so its output can be shared.

**Integration suite**:
Tests that run the real server and client against a local stand-in for the vendor API, with the same transport security (ADR 0019).
_Avoid_: end-to-end tests, live tests

## Quality

**Mutation score**:
The share of deliberately injected code changes that the test suite detects, measured over the configured decision-logic files only. The build fails below 95 %.

**Safety ceiling** (`SAFETY_CEILINGS`, `safetyViolations`):
The largest number of undetected mutants allowed in one safety-critical file, equal to its known equivalent mutants. One file over its ceiling fails the build even when the overall score holds (ADR 0027).
_Avoid_: floor, threshold (those are the overall score's)

**Incremental chain**:
The cached sequence of mutation results each run builds on, keyed by a hash of the mutation and test configuration, so a change to what is mutated or tested starts a fresh chain and results of removed files never count.
_Avoid_: baseline (the weekly full run's saved result)

**Code pull request**:
A pull request that changes source, tests, package manifests or test and mutation configuration. Only these run the mutation job; any doubt about the changed-file list counts as code.
_Avoid_: non-docs PR

**First reviewer** (Greptile, check `Greptile Review`):
The automated review that runs on every pull request. Its valid findings are fixed before merge; there is no separate confidence status (ADR 0029). The principal review is advisory, at phase end or on demand.
_Avoid_: CodeRabbit (no longer used), bot review

**Synthetic fixture**:
Test data written by hand in the shape the API uses, with placeholder values and nil ids. Never a copy of a vendor or customer payload.

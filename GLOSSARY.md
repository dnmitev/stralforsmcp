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
A human name given to an agreement id in configuration so reports and logs can refer to the agreement without exposing the id.
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
The stable, machine-readable classification of a failure (`auth`, `agreement_not_found`, `write_blocked`, ...). Consumers branch on the kind, never on message text.

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
One line per tool call outcome carrying identity, outcome codes, duration and the API trace id; it has no field for arguments, payloads, agreement ids or consignment ids.
_Avoid_: access log, trace

**Outcome** (`Outcome`):
`allowed`, `denied`, `blocked` (stopped by the write guard) or `error` (upstream or client failure).

**Masked identifier** (`mask`):
An identifier shown as its first and last four characters; anything shorter than sixteen characters is shown as "…" only.

## Quality

**Mutation score**:
The share of deliberately injected code changes that the test suite detects. Core client modules target 80 %; the build fails below 70 %.

**Confidence status** (`review/confidence`):
The commit status the principal review publishes: how confident the review is that the exact head commit adds no defect, security issue or leak. A pull request merges only above the agreed threshold.

**Synthetic fixture**:
Test data written by hand in the shape the API uses, with placeholder values and nil ids. Never a copy of a vendor or customer payload.

# Stralfors MCP

Vocabulary of this server and of the Stralfors Output Management API as seen through it. Terms carry the code identifier in parentheses where one exists. A term marked *(rename?)* is used under another name in the code or docs today; the recommendation is noted.

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

**Agreement id** (`actionId` on the wire, `Profile.actionIds[].id`):
The UUID that selects one customer contract on the API side. Required for validation and sending; optional when listing channels.
_Avoid_: action id, contract id, GUID (unqualified)
*(rename?)* `Profile.actionIds` could be `agreements`; keep `actionId` only where it crosses the wire.

**Agreement label** (`Profile.actionIds[].label`):
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

**Safe message** (`StralforsError.message`, `safeMessage`):
An error message made of fixed text only: it never contains header values, body text, secrets or identity ids.
*(rename?)* `message` and `safeMessage` are the same value; one name should go.

## Tokens

**Token source** (`TokenSource`):
The per-profile supplier of access tokens: fetches, caches, refreshes ahead of expiry and invalidates on an unauthorised answer.

**Single flight** (`inflight`):
The rule that concurrent callers waiting for a token share one upstream request instead of each fetching their own.

**Claims** (`Claims`):
The decoded, unverified payload of an access token, exposing scopes, expiry and audience. The raw payload stays private.

**Scope** (`Claims.scopes`):
A permission the API grants to a credential profile, fixed per client and read from the token, never requested.

**Proven agent** (`proven`):
A connection agent that has received at least one HTTP response. Before that point a reset connection is treated as a TLS rejection; after it, as a network fault.

## Quality

**Mutation score**:
The share of deliberately injected code changes that the test suite detects. Core client modules target 80 %; the build fails below 70 %.

**Confidence status** (`review/confidence`):
The commit status the principal review publishes: how confident the review is that the exact head commit adds no defect, security issue or leak. A pull request merges only above the agreed threshold.

**Synthetic fixture**:
Test data written by hand in the shape the API uses, with placeholder values and nil ids. Never a copy of a vendor or customer payload.

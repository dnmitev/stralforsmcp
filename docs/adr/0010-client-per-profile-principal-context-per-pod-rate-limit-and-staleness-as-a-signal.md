---
status: accepted
---
# One client per profile, principal context in async-local storage, per-pod rate limit, staleness as a signal

The server now calls the vendor on behalf of callers. It is configured with one or more credential profiles, runs as several replicas with no shared store, must attribute a blocked write in the audit log to the caller who caused it, and may at any time lose the ability to reload its token list. Four related decisions follow.

## Decision

1. **One Stralfors client per credential profile for the process lifetime.** `start()` builds a client for every configured profile before the listener opens and closes them after the HTTP drain, in that order. Tools receive the clients as a map keyed by profile id and never build their own. Agreements are addressed by label; the server maps the label to the id, so an agreement id never enters a tool argument, result or audit line. The TLS agent and the token cache are therefore shared by every call on a profile and secrets are read from disk once.
2. **The calling principal travels in `AsyncLocalStorage`, not through client signatures.** The registry wraps every tool run in `withPrincipal`; anything reached inside that scope can read `currentPrincipal()`. The client library stays principal-agnostic: its `onBlocked` hook knows a profile, a method and a path template, and the server-side adapter adds the principal from the context.
3. **Rate limiting is a token bucket per authenticated principal in process memory.** It runs after authentication and before the MCP handler, keyed by user id, with `perMinute` refill and `burst` capacity. A refusal is a 429 with `Retry-After` in whole seconds and one audit event (`denied`, `rate_limited`, tool `-`). The ceiling is per pod: with N replicas behind a load balancer a principal may reach up to N times the configured rate. This is documented rather than solved.
4. **Token-list staleness is measured and signalled, readiness is unchanged.** The store reports `staleMs` (zero while the last reload succeeded) and, once the threshold is crossed during a failing reload, calls `onStale` once; the server writes one fixed line. The signal re-arms after the next successful reload. Readiness stays "accepting work until shutdown", as ADR 0006 chose: the last good list keeps serving.

## What is and is not guaranteed

- Every tool call through the registry runs inside a principal context. A blocked write produces two audit lines: `blocked` / `write_guard` from the hook, with the principal read from the context, and `error` / `write_blocked` from the wrapper, with the principal the registry already holds. The hook line carries a principal only when the hook fires inside a tool call; a call made on a client outside the registry (start-up, tests, a future background job) is still audited as `blocked` but without a principal. The two lines are not linked by an identifier; they share the user id, tool name and timestamp only.
- The async-local scope follows Node's async continuation rules. A continuation created inside the principal context keeps the principal even if nothing awaits it, so an unawaited `setTimeout` started within a tool run still reads it. Whether a callback sees the principal depends on the context in which it runs, not on who created the queue or emitter: a synchronous listener runs in the context of the code that calls `emit()`, a callback drained from a shared queue runs in the context of whoever drains it (for example a different request), and a timer created outside a tool run has no principal. No code in this repository does that today; it is a convention, not a check.
- The limiter's memory is bounded by the token list: only authenticated principals get a bucket, and a bucket that has been full and idle for one refill period is dropped on the next call to the limiter. An unauthenticated flood never creates a bucket. The drop is a scan over all buckets on every call, which is fine for the user counts a token-list file implies and would need a periodic sweep beyond that.
- Nothing is shared between replicas. The limit, the buckets and the staleness clock are each per process; a client that is routed to several pods sees each pod's bucket separately.
- A stale token list keeps serving the users and digests of the last good load, including tokens that have since been revoked or expired in the file. The warning is the only signal; nothing stops traffic until an operator acts.
- The staleness threshold is only checked when a reload fails. A reload that silently never runs (timer not firing) is not detected by this signal.
- Clients are closed on every exit path of `start()`, including a failed listen; a client whose close rejects turns the overall close into a failure after the others have been attempted.

## Considered and rejected

- A client per request: a TLS handshake and a token fetch per call, no cache, secrets re-read from disk on every request.
- Passing the principal through `src/stralfors` signatures: couples the client library to the server's identity model and changes every operation signature for one hook.
- A per-IP limit: callers arrive through a NAT or a shared egress, so one address is many users and many addresses are one user.
- A distributed limiter (Redis or similar): there is no shared store in the deployment yet; adding one for a per-user courtesy limit is not justified while the upstream has its own 429.
- Flipping readiness on staleness: a configuration outage would take every replica out of rotation at once, which is the opposite of what the last-good reload in ADR 0006 was for.

## Revisit when

A shared store exists (move the limiter there and make the ceiling global); per-user scopes are needed; the token list moves off a file; or a background job must call the client outside a tool call and needs attribution.

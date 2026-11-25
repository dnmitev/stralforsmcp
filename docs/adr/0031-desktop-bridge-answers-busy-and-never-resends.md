---
status: accepted
---
# The Desktop bridge answers a busy server and never resends

The bridge used to exit on any failed send other than 401, so a rate limit or a pod without a ready endpoint ended the user's Claude Desktop session. The obvious fix, retrying on 429 and 503, is unsafe: the bridge forwards messages verbatim and cannot tell a `tools/call` for `send_invoice` from a read, and a send must never go out twice (ADR 0028).

## Decision

1. **Busy is answered, not retried.** On a 429 or 503 the bridge answers the pending request with a fixed error, `server busy or unavailable; try again, but check whether a send went through (track_document) before repeating it`. It writes one fixed stderr line and keeps running. Every other failure answers and then exits, as before.
2. **The bridge never resends.** Whether to try again is the user's or the client's decision, made after checking the outcome. The `consignmentId` stays the backstop: the API refuses a duplicate within its window.
3. **The safety argument is pinned in this repository.** The server answers `/mcp` with 429 only from its rate limiter, before any handler runs, and never with 503. A test reads the HTTP front to keep this true; under mutation testing it skips the instrumented copy. A 503 on `/mcp` therefore comes from an ingress or proxy with no ready pod.

## Consequences

- A third-party gateway that answers 503 after forwarding could still lead a user to retry a processed send. Only the API's duplicate refusal stops that, and whether that refusal holds for two concurrent requests is an open question to the vendor.

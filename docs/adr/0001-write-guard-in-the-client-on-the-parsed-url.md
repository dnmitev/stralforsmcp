---
status: accepted
---
# The write guard lives in the HTTP client and judges the parsed URL

Every request passes a fail-closed method-and-path check before a token is fetched or a socket is opened; in `prod` only a fixed list of reads (plus the dry run when explicitly enabled) passes, in `test` writes need an explicit switch. We put this in the client rather than only in the MCP policy layer so that no caller, tool or script can reach a write by construction, and we evaluate it on the `URL` object that is actually sent (`pathname` + `search`) because a hand-split string let `validate?test=true?x` through while the server saw a different query.

## Consequences

- Phase 2 policy is a second layer, never the only one; tests for new operations must include a guard case.
- A new read endpoint in `prod` is a deliberate code change to the allowlist, not configuration.

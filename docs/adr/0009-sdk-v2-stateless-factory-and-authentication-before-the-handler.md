---
status: accepted
---
# MCP SDK v2 with a stateless factory per request and authentication before the handler

The server is hosted behind a load balancer with several replicas and callers present personal access tokens. SDK v1 (`@modelcontextprotocol/sdk`) is maintenance-only and stops at the 2025 protocol; v2 serves both the 2025 handshake and the 2026-07-28 envelope from one endpoint. We use `@modelcontextprotocol/server` and `@modelcontextprotocol/node` v2 at exact pins (no caret), without Express, and build the HTTP front on `node:http` ourselves.

## Decision

1. **One fresh `McpServer` per request.** `createMcpHandler` receives a factory that builds a new server for every request and registers only the tools the policy lists for that principal (`responseMode: 'json'`, `legacy: 'stateless'`). Per-caller `tools/list` therefore follows from what was registered, not from enabling or disabling tools on a shared instance; a tool that was not registered is an unknown-tool protocol error. A shared instance was ruled out because the SDK refuses a second connection on one server.
2. **No session.** The handler issues no session id and accepts none; any replica can answer any request. Server-to-client push is not available in this shape and is not needed yet.
3. **Authentication before the handler.** The `node:http` front answers health endpoints, runs the transport guards (Host, Origin, path, method, declared body size) and then authenticates, in that order, before the SDK handler sees the request. The principal travels to tools in `AuthInfo.extra`; `AuthInfo.token` is the empty string so the SDK never retains the secret, and `expiresAt` is in seconds because the SDK compares it to `Date.now() / 1000`.
4. **The 401 is hand-written.** The SDK's bearer helpers (`verifyBearerToken`, `bearerAuthChallengeResponse`) put a cause-specific message in both the body and the `WWW-Authenticate` header, which would tell an unauthenticated caller why a token failed. We send one fixed header and body for every cause; the verify code goes to the audit event only.
5. **Guard refusals are not audited.** A 403, 404, 405 or 413 carries no identity and no tool name, and auditing them would let an unauthenticated flood fill the audit log. Only refused authentication (tool `auth`) and tool calls produce audit events. A tool call whose arguments fail the SDK's schema validation is rejected by the SDK before our wrapper runs, so it produces no audit event; it carries no identity-relevant outcome and the arguments are never logged.
6. **Closed audit reason.** `AuditReason` is a union of fixed codes (deny reasons, verify codes, Stralfors error kinds, `write_guard`, `error`). The type checker rejects any other string at the call sites it can see.

## What is and is not guaranteed

- Tools a principal may not use are absent from that principal's server; this holds for every request routed through the HTTP front, because the factory only runs with the `AuthInfo` the front attached. Calling the handler directly without `AuthInfo` yields a server with no tools.
- A thrown tool error reaches the client only as `tool failed` because the registry wraps every registered tool; a tool registered by any other path would leak its message, since the SDK itself copies the thrown message into the result.
- The declared-size check runs before authentication; a body that is chunked or misdeclared is bounded by the SDK's own 413 after authentication.
- The closed reason union is enforced by the compiler only where the value is typed; free-form strings elsewhere in the event (`tool`, `traceId`) stay a review convention, as ADR 0008 records.
- Legacy-era responses are server-sent events regardless of `responseMode`; only the modern era answers with plain JSON.

## Shutdown order

Readiness to 503, stop listening, close idle connections, wait up to the drain period for in-flight requests, close the handler, close remaining connections. The order matters because a load balancer must stop routing before the listener goes away.

## Considered and rejected

- SDK v1 with `sessionIdGenerator: undefined`: no 2026 envelope, maintenance-only.
- Express with `requireBearerAuth`: a second framework for one route, and the same cause-revealing 401.
- Sessions with sticky routing: ties a caller to a replica and adds state to drain.
- A shared `McpServer` with per-call `enable()`/`disable()`: not supported for concurrent connections in v2.
- Authorisation inside tool handlers only: the policy would run after the tool was already listed and callable.

## Revisit when

The SDK offers a per-request tool filter on a shared instance; the server needs server-to-client push; or clients require OAuth discovery (RFC 9728) instead of personal tokens.

---
status: accepted
---
# Shutdown sequence and operability signals

The server is about to be deployed by a separate repository. A security and operations audit found that a rollout cut requests that arrived while Kubernetes was still routing to the pod, that a failed token list reload left no trace, and that nothing warned before a client certificate expired or when the vendor was down. This ADR records the shutdown order and the signals added. Alert rules, dashboards and the runbook that use them are written with the deployment hand-off, not here.

## Decision

1. **Readiness drops first, the listener closes later.** On SIGTERM `/readyz` answers 503 at once and the server keeps accepting connections for `MCP_READY_DELAY_MS` (integer 0-120000). Only then does it stop listening and drain in-flight requests for `MCP_DRAIN_MS`. The default is 0, so local runs behave as before; the chart sets a value that covers endpoint propagation behind the ingress.
2. **Client close is bounded.** Closing the upstream clients is abandoned after a fixed 3 s, so a hung upstream cannot push the total past the pod's termination grace period. The telemetry flush keeps its own 5 s bound. An abandoned close is not an error.
3. **Budget.** The configured waits add up to `MCP_READY_DELAY_MS + MCP_DRAIN_MS + 3 s + 5 s`. This is not a process-exit bound: the 3 s timer stops awaiting `client.close()` but does not cancel in-flight upstream I/O (aborting that is a later plan). The termination grace period must exceed that sum; calls that normally finish should fit inside the drain. A tool call has no end-to-end bound: the upstream timeout (30 s by default, `STRALFORS_TIMEOUT_MS`) applies to each vendor request, not to the call, so one call can make several requests (a poll, a token fetch and the single retry after a 401), and a channel lookup's 20 s is only its polling deadline, checked after the first vendor request returns. Size the drain for the calls that normally finish (for example the configured upstream timeout plus the polling deadline; the example uses the 30 s default, so a larger `STRALFORS_TIMEOUT_MS` needs a larger drain) and accept that a rarer slower call is cut at the end of the drain; the termination grace period is the hard limit. The chart enforces the relation: rendering fails unless `terminationGracePeriodSeconds * 1000 > readyDelayMs + drainMs + 8000`, and its defaults are 5000 + 10000 inside a 30 s grace. It has no `preStop` hook (distroless, no `sleep`; the server's own ready delay does that job).
   *Amended 2026-11-22.* A caller cancel or dropped connection now aborts the upstream request in flight (ADR 0026), and the channel lookup's 20 s is a hard budget for the whole call, start request included, that aborts the request in flight when it runs out. The shutdown order and the budget relation are unchanged.
4. **Readiness stays independent of the vendor and the token list.** A stale list or a vendor outage keeps serving what it can (ADR 0006, ADR 0010); taking every replica out of rotation would turn a configuration or vendor problem into a total outage. Signals, not readiness, report these states.
5. **Token list reloads are visible.** The store now logs one fixed-text warning per failure cause, suppressed only for consecutive repeats of the same cause (failures A, B, A give three warnings) and a counter `mcp.token_list.reloads{outcome=ok|failed}` records every tick. The stale line goes through the structured logger. The last good list still keeps serving, so a revocation edit that fails to parse does not take effect until a later reload succeeds; the counter and the `mcp.token_list.stale_seconds` gauge are how an operator finds out. Warnings carry no user id, token hash or file content.
6. **Certificate expiry and credential reloads are measured.** `stralfors.client_cert.expiry_seconds` is the time to the earliest certificate not-after across profiles, computed at scrape time; it has no label, so no profile id or certificate field leaves the process. `stralfors.credentials.reloads{outcome}` counts successful swaps and every failing tick (the log warning follows the same rule: once per run of the same cause, so A, B, A warns three times).
7. **A vendor heartbeat, never a gate.** Every `MCP_HEARTBEAT_S` seconds (default 60, 0 disables) the server calls the existing v1 health read per profile; `stralfors.up{api="omni",env}` is 1 only if every profile's last probe returned `UP`. A state change logs one fixed line; the response body and error text are never logged. The probe uses the existing PROD read allowlist and never touches readiness. The series appears after the first interval, not at start.

## Not covered

- Alert rules, dashboards, a ServiceMonitor and the runbook (hand-off plan).
- A per-profile certificate or heartbeat label; add one only if an operator needs it, and review its cardinality first (ADR 0011).
- Probing the other vendor APIs (track and trace, channel lookup); `api` has the single value `omni`.
- Stopping the heartbeat when a profile is removed at runtime; profiles are fixed at start.

## Revisit when

An operator needs per-profile expiry or health, the deployment adds a startup or readiness dependency on the vendor, or the shutdown budget no longer fits the grace period.

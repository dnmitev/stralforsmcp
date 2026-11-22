---
status: accepted
---
# A per-pod upstream cap that refuses at once, with no queue

When the vendor slows down, every tool call holds a socket and memory until its upstream timeout, and calls keep arriving, so a slow vendor could exhaust a pod. We cap concurrent Stralfors requests per pod (`MCP_UPSTREAM_CONCURRENCY`, default 16, 1 to 1000) and refuse a request over the cap at once with the error kind and audit reason `busy` (`tool failed: busy` to the caller). There is no queue, no wait for a free slot and no circuit breaker.

## Decision

1. **One cap per pod, shared by every profile's client.** It counts upstream requests, not tool calls: a tool that polls takes a slot per request. Token fetches are not counted, so a refresh can never be starved by the requests waiting on it.
2. **Acquired after the write guard, before any token fetch or socket; released on every path** (success, error, timeout, caller cancel). A request the write guard blocks never takes a slot.
3. **Fast refusal instead of a queue.** A queue would only move the pile-up from sockets into memory and add latency on top of the vendor's; the caller (an agent) can retry, and an operator sees `busy` in the audit and the runbook. Replicas multiply the total the vendor sees.

## Considered options

- A wait queue with a deadline: rejected for the reason above and because it hides vendor slowness from the signal.
- A circuit breaker that opens on errors: rejected as more state than the problem needs; the vendor heartbeat already reports an outage.
- A chart value: not added; the cap is set through `extraEnv` like the other server settings.

## Revisit when

`busy` appears while the vendor is healthy (the cap is too low for normal load), or a cross-pod limit is needed because the vendor imposes one.

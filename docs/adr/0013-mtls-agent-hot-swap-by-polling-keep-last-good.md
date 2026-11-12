---
status: accepted
---
# mTLS agent hot-swap by polling, keep last good, close not destroy

The Stralfors client authenticates with an mTLS client certificate. Kubernetes mounts Secrets as volumes that update in place, and the test certificate expires on a known date, so a renewal must reach a running pod without a restart or a reloader sidecar. This matches the token list reload in ADR 0006.

## Decision

1. **Poll, do not watch.** Every client re-reads its cert, key and optional passphrase files every `STRALFORS_CERT_RELOAD_S` seconds (default 60, positive integer) on an unref'd interval. `fs.watch` was rejected: Kubernetes updates a mounted Secret by swapping the `..data` symlink, which `fs.watch` does not follow reliably, and a watch can miss an event that a poll never misses.
2. **Content compare, not mtime.** The trimmed content of the three files is compared with the material in use. Unchanged content creates no agent, so keep-alive connections survive; a rewrite with identical content is not a change.
3. **Keep the last good agent.** A new agent is built only from material that reads, is not empty, has a key that opens with the passphrase, and a cert that is PEM. Any failure keeps the current agent and logs one `credentials.reload_failed` warning with the profile and a failure kind (`read`, `empty`, `pem`, `key`), once per distinct kind until a tick succeeds. The line carries no path, content or error text.
4. **Close, never destroy.** The new agent is assigned first, then the old one is closed, so in-flight requests finish on the old connections and new requests use the new agent. The token fetch takes the current agent through a getter, so it also presents the new certificate.
5. **Shutdown wins.** `close()` clears the timer first and sets a flag, so a tick during or after `close()` creates no agent.
6. **Each agent has its own proof state.** The "connection reset means TLS until proven" classification of ADR 0003 is tracked per agent, so a fresh agent starts unproven, which is the right behaviour for a new certificate.

## Not covered

- Client id and secret rotation is out of scope and deferred: the token source reads them at start only and a rotation needs a restart.
- No metric for reloads; the warning log is the signal. A gauge belongs with the dashboards.
- One interval per client, so several profiles poll several times; the cost is three small file reads each.
- A new certificate that reads and parses but is rejected by Stralfors is not detected by the reload; it shows up as TLS errors on the next request.

## Revisit when

Client id or secret rotation is needed without a restart, or the poll cost or latency of up to one interval matters.

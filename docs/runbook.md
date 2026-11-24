# Runbook

For the person on call for a deployed stralforsmcp. It assumes the Helm chart in `charts/stralforsmcp` and the contract in [hosting-handoff.md](hosting-handoff.md). Alerts from the chart's optional `PrometheusRule` link to the sections below by name.

Every command uses placeholders: replace `<release>`, `<namespace>` and file paths with your own values. Never paste credential, token or certificate contents into a ticket or chat.

## Where to look first

- `kubectl logs deploy/<release>-stralforsmcp -n <namespace>`: one JSON object per line on stderr (operational logs). Fixed messages, no payloads. Useful `msg` values: `token_list.stale`, `reload.failed` (token list), `credentials.reload_failed` (certificate or key swap).
- Metrics on port 9464 (separate `<release>-stralforsmcp-metrics` Service). Names: `stralfors_up`, `stralfors_requests_total`, `stralfors_client_cert_expiry_seconds`, `stralfors_credentials_reloads_total`, `mcp_token_list_stale_seconds`, `mcp_token_list_reloads_total`, `mcp_tool_calls_total`, `mcp_auth_rejections_total`, `mcp_http_rate_limited_total`, `http_server_request_duration_*`.
- Audit lines (tool calls and refused tokens) go to stdout of the same container, as JSON lines; see the privacy section of the [README](../README.md#privacy-and-data-handling).
- Readiness never depends on the vendor or the token list: a pod can be Ready while the vendor is down. Check `stralfors_up`.

## Issuing a token

Tokens are `smcp_` strings. Only the SHA-256 hash is stored, in the token list Secret. The raw token is shown once and cannot be recovered.

Use the token wizard from a checkout of this repository (`npm ci` once) on a trusted machine. It works on a local copy of the token list and refuses to write anything the server would reject (unknown role or environment, more than 90 days, duplicate or unknown ids). An existing file that is already invalid is refused with the same message the server logs (for example `token list: users[0].role is invalid`) and left unchanged.

1. Get the current list into a local file (for example from the Secret behind `tokenList.secretName`; keep it mode 600 and delete it afterwards).
2. Run the wizard and follow the menu, or use the commands directly:

   ```sh
   npm run token -- --file token-list.json                       # interactive
   npm run token -- access                                       # what each role may call per environment
   npm run token -- add-user --file token-list.json --name "Alice Example" --role dev --env test   # prints the generated id, e.g. u_3f9c2a71
   npm run token -- issue --file token-list.json --user u_3f9c2a71 --days 30
   npm run token -- list --file token-list.json                  # 8-character token ids, never hashes
   ```

   User ids are generated (`u_` plus 8 random hex characters, nothing about the person); `--id` sets one explicitly. `issue` prints the token id, the user's id, name, role, environments and expiry, and the raw token once on stderr. Roles are `dev`, `qa`, `pm`; environments `test`, `prod` (ADR 0007). Only `dev` may use `prod`; on `test` all roles see the same tools.
3. Update the Secret behind `tokenList.secretName` from the file (`kubectl create secret generic ... --from-file=token-list.json=<file> --dry-run=client -o yaml | kubectl apply -f -`, or your secret store).
4. Wait for the reload (see latency below) and check `mcp_token_list_reloads_total{outcome="ok"}` increased and `mcp_token_list_stale_seconds` is 0.
5. Send the raw token to the user over a private channel. Tell them to keep it in their client's secret store.

Editing the JSON by hand still works (format in ADR 0006), but a wrong value stops new pods from starting.

## Revoking a token

1. `npm run token -- revoke --file token-list.json --token <id>` (one token, id from `list`) or `--user <id>` (all tokens of a user). The entry is kept with `"revoked": true`: a revoked entry answers 401 for that token and leaves a trace of why.
2. Update the Secret as above. Later, `npm run token -- prune --file token-list.json [--older-than-days N] [--users]` removes tokens that expired at least N days ago and, with `--users`, users left without tokens.
3. Confirm the reload counter increased with `outcome="ok"`.

**Latency.** The server re-reads the list every 60 seconds. A revoked token keeps working until the pod's next successful reload, plus the time Kubernetes takes to propagate the Secret into the pod (up to about a minute or more). Plan for roughly two minutes. To skip the wait, restart the pods (`kubectl rollout restart deploy/<release>-stralforsmcp -n <namespace>`) and wait for `kubectl rollout status deploy/<release>-stralforsmcp -n <namespace>`: the revocation applies as each pod is replaced.

If the reload fails, the previous list stays in force, so a revocation is **not** applied: treat `mcp_token_list_stale_seconds > 0` during a revocation as an incident (see [Token list reload failing](#token-list-reload-failing)).

## Rotating the client certificate and key

Certificates and keys are polled from the mounted Secret every `STRALFORS_CERT_RELOAD_S` seconds (default 60). A pair that fails to load is rejected and the last good pair stays in use.

1. Update the profile Secret with the new `client.pem` and `client.key` (and `key-passphrase` if used). Update both keys in one change so the pod never sees a mismatched pair; a single transient mismatch only logs a warning and is retried.
2. Within about two minutes `stralfors_credentials_reloads_total{outcome="ok"}` increases and `stralfors_client_cert_expiry_seconds` jumps to the new value.
3. Verify with one `list_channels` call from a client.

## Rotating the OIDC client id or secret

Client id, client secret and `action-ids` are read at start. Update the profile Secret, then `kubectl rollout restart deploy/<release>-stralforsmcp -n <namespace>`. Check `stralfors_up` returns to 1 and a `list_channels` call works.

## Upstream errors

Alert `StralforsMcpUpstreamErrors`: more than 20 % of vendor requests fail for 10 minutes.

1. Check `stralfors_up`. If 0, go to [Vendor heartbeat down](#vendor-heartbeat-down).
2. Split by `error_type` in `stralfors_requests_total{outcome="error"}`. `tls` points at [Certificate expiry](#certificate-expiry) or [Credential reload failing](#credential-reload-failing); `auth` points at a rotated or revoked client secret; `timeout` and `upstream` point at the vendor or the network.
3. If only one operation fails, it is probably a vendor-side issue for that operation. Check the vendor status channel before changing anything.
4. Audit reason `busy`: the per-pod cap `MCP_UPSTREAM_CONCURRENCY` was full, usually because the vendor is slow and calls pile up. Fix the slowness first; raise the cap only with memory headroom. Reason `cancelled`: the caller cancelled or disconnected and the vendor request was aborted; a burst of them alongside `timeout` means clients give up before the vendor answers.

## Vendor heartbeat down

Alert `StralforsMcpVendorDown`: `stralfors_up` has been 0 for 10 minutes (the probe runs every `MCP_HEARTBEAT_S`, default 60). Knowledge tools keep working; Stralfors-backed tools fail.

1. Confirm from another route that the vendor is up (status page, vendor contact). A vendor outage needs no action here beyond telling users.
2. If the vendor is up, check egress from the pod (network policy, proxy, DNS) and the certificate and credential alerts.
3. Do not restart pods as a first step: it does not help and drops in-flight connections (the Desktop bridge does not reconnect).

## Certificate expiry

Alerts `StralforsMcpCertExpirySoon` (under 30 days) and `StralforsMcpCertExpiryCritical` (under 7 days). The gauge shows the earliest expiry across profiles.

1. Ask the certificate owner (the process is yours to define in the handoff) for a renewed pair now; vendor issuance can take days.
2. Install it as described in [Rotating the client certificate and key](#rotating-the-client-certificate-and-key).
3. Confirm the gauge increased. Expired certificates stop all vendor calls for that profile.

## Token list reload failing

Alert `StralforsMcpTokenListStale`: the list has been served from the last good copy for over 5 minutes. Existing tokens keep working, new tokens are unknown, and **revocations are not applied**.

1. Read the logs for `reload.failed`: one fixed-text warning per distinct cause (unreadable file, invalid JSON, schema or cross-check failure).
2. Fix the Secret content (validate the JSON locally: the same rules apply as at start, including the 90-day maximum lifetime) and re-apply it.
3. Confirm `mcp_token_list_stale_seconds` returns to 0 and a success is counted. If a revocation was pending, restart the pods after the fix.

## Credential reload failing

Alert `StralforsMcpCredentialReloadFailing`: certificate or key swaps have kept failing for about 15 minutes or more (a single failure does not alert; check the logs for `credentials.reload_failed` if you suspect one). The last good pair stays in use, so nothing is broken yet, but the next expiry is not covered.

1. Read the logs for `credentials.reload_failed` and the `kind`.
2. Check that the Secret holds a matching `client.pem` and `client.key` (and passphrase), readable by the pod.
3. Re-apply a correct Secret. Confirm `stralfors_credentials_reloads_total{outcome="ok"}` increases.

## Server errors

Alert `StralforsMcpServerErrors`: more than 5 % of inbound requests answer 5xx for 10 minutes.

1. Check `kubectl get pods`, recent events and the logs for the failing route. Fixed error texts do not carry payloads.
2. If it began at a deploy, [roll back](#rolling-back).
3. If pods are OOM-killed, raise `resources.limits.memory` and `heapMaxMb` together (keep the heap near 75 % of the limit).

## Restarts

Alert `StralforsMcpRestarting` needs kube-state-metrics. More than two container restarts in 30 minutes.

1. `kubectl describe pod` for the last state and reason (OOMKilled, Error) and `kubectl logs --previous`.
2. OOMKilled: see Server errors above. A crash at start prints a fixed one-line reason (configuration, listener, credential file); fix the cause named, do not loosen guards.

## Rolling back

1. `helm history <release> -n <namespace>` and note the last good revision.
2. `helm rollback <release> <revision> -n <namespace>` (or redeploy the previous image tag or digest through your pipeline).
3. Wait for the rollout; check `/readyz`, `stralfors_up` and one tool call.
4. Secrets are not rolled back by Helm: if the bad change was a Secret, restore it from your secret store.

Rollouts keep serving during the readiness delay and drain; see ADR 0023 for the budget.

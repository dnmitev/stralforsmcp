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

1. Generate a token and its hash on a trusted machine, from a checkout of this repository (`npm ci` once):

   ```sh
   node -e "import('./src/auth/index.ts').then(({generateToken,hashToken})=>{const t=generateToken();console.log('token (give to the user once):',t);console.log('hash (goes in the list):',hashToken(t))})"
   ```

2. Add the user (if new) and the token to the token list, for example:

   ```json
   {
     "users": [{ "id": "alice", "name": "Alice Example", "role": "dev", "envs": ["test"] }],
     "tokens": [{ "hash": "<hash>", "userId": "alice", "created": "2030-01-01T00:00:00Z", "expires": "2030-03-01T00:00:00Z" }]
   }
   ```

   `expires` must be after `created` and at most 90 days later. Roles and environments are explained in ADR 0007.
3. Update the Secret behind `tokenList.secretName` from the edited file (`kubectl create secret generic ... --dry-run=client -o yaml | kubectl apply -f -`, or your secret store).
4. Wait for the reload (see latency below) and check `mcp_token_list_reloads_total{outcome="ok"}` increased and `mcp_token_list_stale_seconds` is 0.
5. Send the raw token to the user over a private channel. Tell them to keep it in their client's secret store.

## Revoking a token

1. Set `"revoked": true` on the token entry. Do not delete it in the same edit: a revoked entry answers 401 for that token, and keeping it for a while leaves a trace of why.
2. Update the Secret as above. Delete entries (and users with no tokens) in a later edit.
3. Confirm the reload counter increased with `outcome="ok"`.

**Latency.** The server re-reads the list every 60 seconds. A revoked token keeps working until the pod's next successful reload, plus the time Kubernetes takes to propagate the Secret into the pod (up to about a minute or more). Plan for roughly two minutes, and restart the pods (`kubectl rollout restart deploy/<release>-stralforsmcp`) for an immediate effect.

If the reload fails, the previous list stays in force, so a revocation is **not** applied: treat `mcp_token_list_stale_seconds > 0` during a revocation as an incident (see [Token list reload failing](#token-list-reload-failing)).

## Rotating the client certificate and key

Certificates and keys are polled from the mounted Secret every `STRALFORS_CERT_RELOAD_S` seconds (default 60). A pair that fails to load is rejected and the last good pair stays in use.

1. Update the profile Secret with the new `client.pem` and `client.key` (and `key-passphrase` if used). Update both keys in one change so the pod never sees a mismatched pair; a single transient mismatch only logs a warning and is retried.
2. Within about two minutes `stralfors_credentials_reloads_total{outcome="ok"}` increases and `stralfors_client_cert_expiry_seconds` jumps to the new value.
3. Verify with one `list_channels` call from a client.

## Rotating the OIDC client id or secret

Client id and secret are read at start. Update the profile Secret, then `kubectl rollout restart deploy/<release>-stralforsmcp`. Check `stralfors_up` returns to 1 and a `list_channels` call works.

## Upstream errors

Alert `StralforsMcpUpstreamErrors`: more than 20 % of vendor requests fail for 10 minutes.

1. Check `stralfors_up`. If 0, go to [Vendor heartbeat down](#vendor-heartbeat-down).
2. Split by `error_type` in `stralfors_requests_total{outcome="error"}`. `tls` points at [Certificate expiry](#certificate-expiry) or [Credential reload failing](#credential-reload-failing); `auth` points at a rotated or revoked client secret; `timeout` and `upstream` point at the vendor or the network.
3. If only one operation fails, it is probably a vendor-side issue for that operation. Check the vendor status channel before changing anything.

## Vendor heartbeat down

Alert `StralforsMcpVendorDown`: `stralfors_up` has been 0 for 10 minutes (the probe runs every `MCP_HEARTBEAT_S`, default 60). Knowledge tools keep working; Stralfors-backed tools fail.

1. Confirm from another route that the vendor is up (status page, vendor contact). A vendor outage needs no action here beyond telling users.
2. If the vendor is up, check egress from the pod (network policy, proxy, DNS) and the certificate and credential alerts.
3. Do not restart pods as a first step: it does not help and drops sessions.

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

Alert `StralforsMcpCredentialReloadFailing`: a certificate or key swap failed within the last 15 minutes. The last good pair stays in use, so nothing is broken yet, but the next expiry is not covered.

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

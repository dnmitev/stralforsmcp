# Hosting handoff

What a team needs to deploy and operate stralforsmcp from its own repository: the contract between this repository (image and Helm chart) and the cluster that runs it. Deployment itself (cluster objects, secret wiring, DNS, VPN) is the operator's. For day-to-day operation see the [runbook](runbook.md).

## What you receive

| Artefact | Where | Notes |
|---|---|---|
| Container image | `ghcr.io/dnmitev/stralforsmcp` | distroless Node, linux/amd64 and linux/arm64, built and scanned in CI (ADR 0012) |
| Helm chart | `charts/stralforsmcp` | Secrets by name, hardened pod, PROD guards in templates (ADR 0014); chart README is the reference for every value |
| Desktop extension | `.mcpb` built by `npm run mcpb:build` | local bridge for Claude Desktop (ADR 0015) |

**Image tags.** Pushes to `main` publish `edge` and `sha-<40 hex>`. A strict `v<semver>` tag whose version equals `package.json` publishes `<version>`, `<major>.<minor>` and `latest`; any other `v*` tag is refused before anything is pushed. Pin by tag **and digest** (`image.digest`) in your deployment; never deploy `edge` or `latest` to PROD. How a release is cut, checked and rolled back: [docs/releasing.md](releasing.md). The first release, `v0.1.0`, is cut after plan 05-03c merges: until it exists, pin a `sha-` tag (by digest).

## Verifying the image

Every image pushed from `main` or a `v*` tag is scanned by digest (both platforms, fixable HIGH and CRITICAL findings fail the job) and then signed keylessly with cosign, from the `image.yml` workflow of this repository. A failing scan stops the job before the signature, so **a valid signature means the digest passed the scan at publish time**. The tag is pushed before the scan, so an unsigned tag can exist: deployments must verify the signature and pin by digest.

```sh
cosign verify \
  --certificate-identity-regexp '^https://github.com/<owner>/<repo>/\.github/workflows/image\.yml@refs/(heads/main|tags/v.*)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/<owner>/<repo>@sha256:<digest>
```

Run it in the deployment pipeline before a rollout (or enforce it with an admission policy) and deploy the digest it verified. The SBOM and the build provenance are attached to the image and can be read with `docker buildx imagetools inspect`. The Claude Desktop extension is built in the `mcpb` workflow: its SHA-256 and, for tags, its build-provenance attestation (`gh attestation verify`) are the checks.

A weekly workflow (`rescan.yml`) re-scans the published `edge` image so a newly disclosed fixable vulnerability shows up as a failed run even when nothing is pushed; it scans the current `edge` digest, not an older digest that a deployment pinned, so operators must also rescan the digests they actually run (for example with trivy against the pinned digest on a schedule in their own pipeline). Dependency updates arrive as grouped Dependabot pull requests.

## One deployment per environment

| Environment | Ingress | Who may call |
|---|---|---|
| TEST | internal, optionally public | all roles, TEST tools including writes |
| PROD | **internal only** (VPN) | `dev` role only, read tools plus `validate_invoice` when enabled (ADR 0007) |

Run TEST and PROD as separate releases with separate Secrets and, if you use IAM roles for service accounts, separate roles. The chart refuses to render PROD with a public ingress, extra hostnames, `allowWrite` or no internal ingress class. It cannot see what your internal ingress class exposes: keeping it internal is your job.

## Secrets and identities

The chart never creates a Secret. You create these (by hand or with an external secret operator), and the chart mounts them as volumes without `subPath` so rotations reach the pod:

| Secret | Keys | Reload |
|---|---|---|
| token list (`tokenList.secretName`) | `token-list.json` | re-read every 60 s, last good list kept on failure (ADR 0006) |
| one per vendor credential profile (`profiles[].secretName`) | `client-id`, `client-secret`, `client.pem`, `client.key`, optional `key-passphrase`, optional `action-ids` | certificate and key polled every `stralfors.certReloadS` (default 60 s); client id, client secret and `action-ids` need a pod restart (ADR 0013) |
| OTLP headers (`otlp.headersSecret`) | `headers` | read at start |

The pod needs no cloud permissions of its own. If your platform attaches roles to service accounts, use `serviceAccount.annotations`; this repository does not define the role. Secret values never go in `values.yaml` or `--set`.

## Network

- **Inbound:** port 3000 (`/mcp`, `/healthz`, `/readyz`) from pods in `ingressControllerNamespace` only (the policy admits the whole namespace, so keep that namespace to the controller); port 9464 (`/metrics`) from your Prometheus only, served by the separate `<release>-stralforsmcp-metrics` Service. With `networkPolicy.enabled` (the default) set `ingressControllerNamespace` and `prometheusNamespace` to the real namespaces on every install and upgrade, and make sure your CNI enforces NetworkPolicy.
- **Outbound:** HTTPS with mutual TLS to the vendor API (fixed base URLs per environment, ADR 0005), your OTLP collector if configured, and DNS. There is no egress policy in the chart; add one if your cluster standards require it.
- **Hostnames:** `MCP_HOSTNAMES` (from the ingress hosts and `extraHostnames`) is checked against the Host header; requests for other names get 403.
- **VPN and reachability:** PROD users reach the internal ingress over your VPN. A public TEST host is for users without VPN and must sit behind the ingress rate limits below.
- **Public TEST ingress:** the server rate-limits per authenticated principal, per pod. Unauthenticated requests are refused with 401 but are not throttled by the server and write an audit line each. Put request rate limiting and a body size limit on any public host at the ingress or in front of it, so a flood cannot crowd out the audit stream or raise log cost.

## Environment variables

The chart sets the variables it knows; the rest go through `extraEnv`. The README lists every variable with its default and rule (section "Running"); the chart README lists what `extraEnv` may not set. Required by the server: `MCP_TOKEN_LIST_FILE`, `MCP_HOSTNAMES`, `STRALFORS_ENV`, `STRALFORS_PROFILES` and the `STRALFORS_PROFILE_<ID>_*` file paths. Credentials are only ever read from files.

## Health, readiness and metrics

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | process is alive; no Host or token needed |
| `GET /readyz` | 200 while serving, 503 once shutdown starts. **Never depends on the vendor or the token list**, so a vendor outage does not take the pod out of rotation |
| `GET :9464/metrics` | Prometheus text, separate listener |

Vendor health is a metric, not a probe: `stralfors_up` (1 when every profile last probed UP). Other signals: `stralfors_client_cert_expiry_seconds`, `stralfors_credentials_reloads_total`, `mcp_token_list_stale_seconds`, `mcp_token_list_reloads_total`, `stralfors_requests_total`. The chart can ship example alert rules and a ServiceMonitor (`prometheusRule.enabled`, `serviceMonitor.enabled`, need the Prometheus Operator CRDs); each alert links to a section of the runbook.

## Rollouts and shutdown

On SIGTERM `/readyz` turns 503 and the server keeps serving for `readyDelayMs` (default 5 s) so endpoints are removed, then drains for `drainMs` (default 10 s), then closes the vendor connections and flushes telemetry. The chart refuses to render unless `terminationGracePeriodSeconds * 1000` exceeds `readyDelayMs + drainMs + 8000` (ADR 0023). There is no `preStop` hook: the image has no shell. The Claude Desktop bridge has no reconnect (ADR 0015): a user whose connection was cut by a rollout may need to restart the extension. The server holds no session state.

## Capacity and limits

- Default is **one replica**. State per pod: the rate limiter (so N replicas allow N times the limit) and the rules cache. Nothing is shared between pods and nothing is persisted, so more replicas are safe; they only multiply those two.
- Requests and limits default to 100m/128Mi and 500m/256Mi with `heapMaxMb` 192. Raise the memory limit and `heapMaxMb` together (heap about 75 % of the limit).
- Tool outputs above `MCP_TOOL_OUTPUT_MAX_BYTES` are refused, not truncated.

## Knowledge overlay

The public knowledge notes ship in the image. A private overlay (`KNOWLEDGE_DIRS`) is **not** offered by the chart, and the rule for when it may be mounted is:

- Not on any deployment that has a public ingress.
- Not at all until resource and prompt policy parity is implemented (tool policy is enforced on tools today, but knowledge resources and prompts are served to every authenticated principal in every environment, ADR 0021 and ADR 0022).

Until then keep private material out of the deployment.

## Data handling

No request or response payloads are logged. Audit lines carry the user id, tool, environment and outcome, with masked identifiers. Logs and audit lines carry a user identifier (traces do not), so their retention and access are set by your logging stack, not by this server. See the privacy section of the [README](../README.md#privacy-and-data-handling).

## Operating it without the author

Before the original author steps back, agree and record in your own (private) documentation:

- [ ] Named primary and second operator, both able to deploy, roll back, issue and revoke tokens ([runbook](runbook.md)).
- [ ] Who holds the vendor credentials and certificates, where they are stored, who renews them and how far ahead (the expiry alerts start at 30 days).
- [ ] How the token list is changed (who edits it, who reviews, how often tokens are cleaned up).
- [ ] Who receives the alerts and what the escalation path is.
- [ ] Who can merge and release in this repository, and a rehearsed rollback. The repository settings behind that (ruleset for `main`, ruleset for `v*` tags, GHCR visibility, who may add the `skip-confidence` label, whether code-owner review is required) are listed in [docs/releasing.md](releasing.md#maintainer-settings-once-before-the-first-release).
- [ ] A dry run: the second operator performs a token issue and revoke and a certificate swap on TEST without help.

## Known limits

Single replica by default (see above); no egress NetworkPolicy, HPA or dashboards in the chart; the knowledge overlay waits for the policy work described above; vendor behaviour that the API documentation does not cover is recorded in the project's own notes, not here.

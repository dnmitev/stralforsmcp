# stralforsmcp Helm chart

Runs the stralforsmcp image. The chart never creates or contains a Secret: every sensitive value is read from Kubernetes Secrets that you create (by hand, or with an external secret operator) and reference by name. Secrets are mounted as volumes without `subPath`, so rotated Secrets reach the pod for the files: certificate, key and passphrase hot-swap (ADR 0013) and the token list reloads. Not everything rotates live: client id and client secret, the `action-ids` key and the OTLP headers Secret (the last two are read once through env `secretKeyRef`) need a pod restart (for example `kubectl rollout restart`).

## Secrets to create

| Secret (value key) | Keys | Mounted at |
|---|---|---|
| `tokenList.secretName` | `token-list.json` (name set by `tokenList.key`) | `/run/creds/token-list` |
| each `profiles[].secretName` | `client-id`, `client-secret`, `client.pem`, `client.key`; optional `key-passphrase` (when `passphrase: true`); optional `action-ids` (read through an optional `secretKeyRef`) | `/run/creds/<profile id>` |
| `otlp.headersSecret.name` | `headers` (name set by `otlp.headersSecret.key`); only used when `otlp.endpoint` is set | env `OTEL_EXPORTER_OTLP_HEADERS` |

Create them from files you own; never put values on the command line:

```sh
kubectl create secret generic example-token-list \
  --from-file=token-list.json=/path/to/operator-owned/token-list.json

kubectl create secret generic example-profile-a \
  --from-file=client-id=/path/to/operator-owned/client-id \
  --from-file=client-secret=/path/to/operator-owned/client-secret \
  --from-file=client.pem=/path/to/operator-owned/client.pem \
  --from-file=client.key=/path/to/operator-owned/client.key
```

## Install

`image.tag` has no default and is required. Replace every `<placeholder>` below before running the command (an unquoted `<` or `>` is a shell redirection).

```sh
helm install stralforsmcp ./charts/stralforsmcp \
  --set 'image.tag=<release-tag>' \
  --set 'profiles[0].id=example-profile' \
  --set 'profiles[0].country=<country-code>' \
  --set 'profiles[0].secretName=example-profile-a' \
  --set tokenList.secretName=example-token-list \
  --set 'networkPolicy.ingressControllerNamespace=<ingress-controller-namespace>' \
  --set 'networkPolicy.prometheusNamespace=<prometheus-namespace>' \
  --set 'ingress.internal.enabled=true' \
  --set 'ingress.internal.className=<ingress-class>' \
  --set 'ingress.internal.hosts[0].host=<mcp-hostname>' \
  --set 'ingress.internal.hosts[0].paths[0].path=/' \
  --set 'ingress.internal.hosts[0].paths[0].pathType=Prefix'
```

## Guards

- `stralfors.env` is `test` or `prod`. With `prod`, rendering requires `ingress.internal.enabled` true with a non-empty `ingress.internal.className`, and independently fails if `stralfors.allowWrite` is true, `ingress.public.enabled` is true or `extraHostnames` is set (hostnames then come only from the internal ingress). The chart cannot know what your internal class exposes: keeping that class internal-only is the operator's job.
- Shutdown budget (ADR 0023): `terminationGracePeriodSeconds * 1000` must exceed `readyDelayMs + drainMs + 8000` (3 s client close + 5 s telemetry flush); rendering fails otherwise. Defaults: 5000 + 10000 + 8000 = 23 s inside a 30 s grace. A larger `STRALFORS_TIMEOUT_MS` needs a larger `drainMs` and grace.
- `extraEnv` may not set a variable the chart sets itself (including any `STRALFORS_PROFILE_*`) or one that moves the listeners the probes, Services and NetworkPolicy assume (`MCP_PORT`, `MCP_LISTEN_HOST`, `MCP_METRICS_PORT`, `MCP_METRICS_HOST`); `value` must be a string (quote numbers), and `extraVolumes` / `extraVolumeMounts` may not reuse the names `token-list` or `creds-<profile id>`.
- Rendering fails when there is no hostname (ingress hosts plus `extraHostnames` feed `MCP_HOSTNAMES`).
- Ingress backends only target port 3000. Metrics (9464) are served only by the separate `<release>-stralforsmcp-metrics` ClusterIP Service; with `networkPolicy.enabled`, port 9464 accepts traffic only from `networkPolicy.prometheusNamespace`.

## Rollouts, probes and memory

- On SIGTERM the server turns `/readyz` to 503 and keeps serving for `readyDelayMs` so the endpoint is removed from the Service and the ingress before the listener closes, then drains for `drainMs`. There is no `preStop` hook: the image is distroless (no shell, no `sleep`) and the server delays itself. A startup probe (`/healthz`, up to 60 s), a liveness probe (`/healthz`) and a readiness probe (`/readyz`) have explicit timings. Readiness never depends on Stralfors or the token list (ADR 0023).
- `heapMaxMb` sets `NODE_OPTIONS=--max-old-space-size`. Keep it at about 75 % of `resources.limits.memory` (192 for the default 256Mi); raise both together.

## Settings beyond the first-class values

First-class: `logLevel` (`MCP_LOG_LEVEL`), `rate.perMinute` / `rate.burst` (`MCP_RATE_PER_MINUTE`, `MCP_RATE_BURST`), `readyDelayMs`, `drainMs`, `stralfors.*`. Everything else the server reads (the root README lists each variable) goes through `extraEnv`, for example `MCP_TOOL_OUTPUT_MAX_BYTES`, `MCP_RULES_CACHE_S`, `MCP_TOKEN_STALE_MS`, `MCP_TRACE_SAMPLE_RATIO`, `MCP_MAX_BODY_BYTES`, `STRALFORS_MAX_BODY_BYTES`, `STRALFORS_TOKEN_REFRESH_MARGIN_S`, `MCP_HEARTBEAT_S`. Secrets still go by file path (ADR 0005): use `extraVolumes` plus `extraVolumeMounts`, not a literal in `extraEnv`.

The knowledge overlay (`KNOWLEDGE_DIRS`) is deliberately not offered: resource and prompt policy parity (plan 05-04) lands first, and whether a publicly reachable TEST deployment may mount an overlay is decided in plan 05-03.

## NetworkPolicy

`networkPolicy.enabled` defaults to true. The policy this chart renders allows port 3000 from `networkPolicy.ingressControllerNamespace` and port 9464 from `networkPolicy.prometheusNamespace`, and nothing else. Isolation only holds if your CNI enforces NetworkPolicy and no other policy selecting the pod admits more; traffic from the pod's own node (kubelet probes) is exempt. **Set both namespaces to your cluster's real names before every install and upgrade** (the defaults are `ingress` and `monitoring`): with an enforcing CNI and a controller in, say, `ingress-nginx`, Helm succeeds but the route stops working. There is no egress policy yet.

Not included: ExternalSecret or IRSA objects, ServiceMonitor, HPA. Pass IRSA-style annotations with `serviceAccount.annotations`.

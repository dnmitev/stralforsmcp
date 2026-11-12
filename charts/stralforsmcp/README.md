# stralforsmcp Helm chart

Runs the stralforsmcp image. The chart never creates or contains a Secret: every sensitive value is read from Kubernetes Secrets that you create (by hand, or with an external secret operator) and reference by name. Secrets are mounted as volumes without `subPath`, so rotated Secrets reach the pod (client certificate hot-swap and token-list reload).

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

`image.tag` has no default and is required.

```sh
helm install stralforsmcp ./charts/stralforsmcp \
  --set image.tag=<release-tag> \
  --set 'profiles[0].id=example-profile' \
  --set 'profiles[0].country=<country-code>' \
  --set 'profiles[0].secretName=example-profile-a' \
  --set tokenList.secretName=example-token-list \
  --set 'ingress.internal.enabled=true' \
  --set 'ingress.internal.className=<ingress-class>' \
  --set 'ingress.internal.hosts[0].host=<mcp-hostname>' \
  --set 'ingress.internal.hosts[0].paths[0].path=/' \
  --set 'ingress.internal.hosts[0].paths[0].pathType=Prefix'
```

## Guards

- `stralfors.env` is `test` or `prod`. With `prod`, rendering fails if `stralfors.allowWrite` is true or `ingress.public.enabled` is true.
- Rendering fails when there is no hostname (ingress hosts plus `extraHostnames` feed `MCP_HOSTNAMES`).
- Ingress backends only target port 3000. Metrics (9464) are served only by the separate `<release>-stralforsmcp-metrics` ClusterIP Service; with `networkPolicy.enabled`, port 9464 accepts traffic only from `networkPolicy.prometheusNamespace`.

Not included: ExternalSecret or IRSA objects, ServiceMonitor, HPA. Pass IRSA-style annotations with `serviceAccount.annotations`.

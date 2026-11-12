---
status: accepted
---
# Helm chart: Secrets by name, no Secret objects, prod guards in templates

Phase 2 ships a Helm chart (`charts/stralforsmcp`) for the container image of ADR 0012. Only the chart lives in this repository. The EKS deployment itself (cluster, ingress controller, external secret tooling, IAM) is done elsewhere by the operator and is out of scope.

## Decision

1. **Secrets by name, never created or valued by the chart.** The chart has no Secret template and no value that holds a credential. Values carry only Secret names (and key names); the operator creates the Secrets by hand or with their own tooling. Nothing sensitive can end up in `values.yaml`, in a release record or in git. This extends ADR 0005 (secrets by file path).
2. **Volume mounts without `subPath`.** Kubernetes updates a mounted Secret by swapping the `..data` symlink. A `subPath` mount is a bind mount of one file and never sees the swap. The certificate hot-swap (ADR 0013) and the token-list reload (ADR 0006) depend on the swap, so every Secret is mounted as a whole directory. The one exception is the optional `action-ids` key and the OTLP headers, which are read once at start through `secretKeyRef` into the environment.
3. **Prod guards duplicated in the templates.** Rendering fails when `stralfors.env` is `prod` and `stralfors.allowWrite` is true, or when the public ingress is enabled with `prod`. The server already refuses prod together with write (ADR 0007), so the template check is defence in depth: a bad value fails at `helm template` or `helm install`, not at pod start-up in a crash loop. The schema and the templates must agree; the chart test covers both.
4. **The metrics port is never behind an ingress.** Ingress backends target port 3000 only. Port 9464 is served by a separate ClusterIP Service. A NetworkPolicy that limits 9464 to the Prometheus namespace is available but optional (`networkPolicy.enabled`, default off), because it needs a CNI that enforces policies and namespace labels the chart cannot know.
5. **`defaultMode: 288`, not `0440`.** Secret volumes use mode 0440 (owner and group read, so the non-root group can read the files). The value is written as decimal 288 with a comment. YAML 1.1 parsers read a literal `0440` as octal and YAML 1.2 parsers read it as decimal 440; Helm, Kubernetes and the `yaml` library used in tests do not all agree. Decimal 288 is unambiguous and Kubernetes receives the same mode.
6. **`yaml` is a devDependency used only by the chart test.** `test/chart.test.ts` renders the chart with `helm template` and parses the output with the `yaml` package. It is never imported by `src/`, so the image (production dependencies only) does not contain it. The test needs the `helm` binary: CI runners have it, a local run needs Helm installed.

## Not covered (YAGNI)

- **External Secrets Operator objects**, since the operator's secret tooling is unknown and out of scope; the chart only needs the Secret to exist.
- **ServiceMonitor**, since it needs the Prometheus Operator CRDs; the metrics Service has the port and can be scraped by static or annotation-based configuration.
- **HorizontalPodAutoscaler**, since the server is stateless but the rate limit is per pod (ADR 0010) and no load data exists; `replicas` is a plain value.
- **Egress NetworkPolicy**, since the Stralfors endpoints are fixed by hostname and egress rules by hostname are not portable across CNIs.

## Revisit when

A consumer needs any of the above, a CNI-independent way to restrict egress exists, or the chart gets more than one deployment shape.

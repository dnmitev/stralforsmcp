---
status: accepted
---
# Manual spans, our own metrics listener, no inbound trace context, structural label allowlists, lockstep OpenTelemetry pinning

The server now emits traces and metrics. It handles authenticated but untrusted callers, forwards to a third party, and must never record payloads, tokens, identifiers, paths or URLs (ADR 0008). The OpenTelemetry JavaScript 3.x line ships as ESM, but its auto-instrumentation needs a loader hook, records `url.full`, headers, query strings and user agents by default, its undici instrumentation injects `traceparent` into outbound requests to the vendor, and its pino instrumentation writes through pino directly, bypassing the log key allowlist. Six related decisions follow.

## Decision

1. **Manual spans only.** Exactly three span kinds exist: the root server span (`POST /mcp`, `SERVER`), the tool span (`mcp.tool <name>`, `INTERNAL`) and the upstream span (`stralfors.request`, `CLIENT`). Attribute keys come from one closed set (`ALLOWED_SPAN_KEYS`); `setSafe` drops and counts any other key as defence in depth. No `@opentelemetry/instrumentation-*` package, no `sdk-node`, no `--import` or loader hook. The client library exposes an `instrument` hook that sees only an operation name and a method, so the client stays free of telemetry imports.
2. **Metrics are pulled by Prometheus from a listener we own.** The exporter runs with `preventServerStart` and we serve `getMetricsRequestHandler` from a plain `node:http` server on `MCP_METRICS_PORT`. The library's own server was rejected on two observed facts: `port: 0` falls back to 9464 instead of a random port, and it answers `POST /metrics` with 200. Our listener answers only `GET /metrics`; everything else is 404. The MCP port answers 404 for `/metrics`, and the metrics port is meant to be kept off the ingress by network policy, not by code. Traces go out by OTLP/HTTP push only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; otherwise spans are created and dropped.
3. **Incoming `traceparent` and `tracestate` are ignored.** Every request is a root span sampled by `MCP_TRACE_SAMPLE_RATIO`. A caller can therefore neither force sampling (and with it export volume) nor choose the trace id that ends up in our logs and audit lines. Nothing is injected outbound either: the vendor never sees our trace context.
4. **`recordException` and free-text status messages are banned.** A failed span gets status `ERROR` and an `error.type` attribute drawn from the closed `AuditReason` set, nothing else. Exception messages and stacks carry upstream text, identifiers and URLs; the same rule that keeps them out of audit lines (ADR 0008) keeps them out of spans. 401 and 429 keep status unset (not server errors) but still carry `error.type`.
5. **Label sets are structural.** One table (`INSTRUMENTS`) defines every instrument together with its label keys; the meter provider gets one allowlist View per table row, so a label that is not in the row is dropped before aggregation whatever the call site passes. The method label is one of the nine standard methods or `_OTHER`; the route label is the fixed template `/mcp`; `error.type` is an `AuditReason`. Histograms use second-scale buckets set explicitly, because the SDK default buckets are millisecond-shaped. The table is under mutation testing.
6. **The OpenTelemetry packages are exact-pinned and bumped only as one set.** The 0.3xx exporters follow the 3.x core; a mixed set installs two copies of the core and silently splits providers. Dependency bots may not bump them one by one; an OpenTelemetry update is one reviewed pull request that moves the whole set. The set adopted on 2026-11-11 was published on 2026-11-09, two days earlier, so no cooling-off period was observed; the probes in the test suite (allowlist View behaviour, exporter port fallback, context manager registration, sampler ids) are what stands in for one, and a future bump should prefer a release that is at least a week old unless it fixes something we need.

## What is and is not guaranteed

- The span key allowlist applies to attributes set through `setSafe`. Future code that calls `span.setAttribute` directly is not covered; the convention is enforced by review and tests, not by the type system.
- The label allowlist applies to instruments that have a row in the table. An instrument created outside the table has no View and passes every label through; a probe showed this. The table is the only place to add an instrument.
- The allowlist bounds label keys, not values. Values are bounded by the code that produces them (closed unions, the method mapping, the fixed route); a new call site that passes caller text under an allowed key would still create cardinality.
- Trace and span ids appear on log and audit lines whether or not the span was sampled, so lines of one request correlate even when no trace is exported. They are not secret and not an identity, but they are never used as a metric label.
- `trace_id` on an audit line is this server's trace id; `traceId` stays the vendor's request id from upstream error bodies. The two are never merged.
- The metrics listener has no authentication, no TLS and no transport guards. Protection is the network policy and nothing in this repository.
- Metric names are exported without a `_seconds` suffix: the unit appears as a `# UNIT` line and histograms are `<name>_bucket`, `_sum`, `_count`. Dashboards must not assume the suffix convention.
- Health probes are not measured; every other request on the MCP port, including guard refusals and unknown paths, lands in the request histogram under the route `/mcp`.
- A successful upstream span carries no response status code; only failures with a status do.
- Exporter failures are swallowed and never reach readiness or the caller; the only observable failure of telemetry shutdown is exceeding the fixed flush bound, which turns the overall close into a failure.
- There is no trace continuity with clients or gateways. A span link or post-authentication extraction are the future options, not a configuration flag.
- The tracer and meter providers are not registered globally; only the context manager is, reference-counted across telemetry instances. Code that relies on `trace.getTracerProvider()` gets the no-op provider.
- The log mixin that adds `trace_id` and `span_id` runs after the log key allowlist. The allowlist protects against call sites, not against the mixin; the mixin is the one fixed function that returns those two keys.

## Considered and rejected

- `instrumentation-http`, `instrumentation-undici`, `instrumentation-pino`: loader hook, URL and user-agent attributes on by default, outbound `traceparent` to the vendor, and a log path around the allowlist. Each is configurable away, but a safe default beats a configured one.
- The exporter's built-in server: port 0 means 9464, `POST` is answered, and `EADDRINUSE` surfaces only through a constructor callback.
- OTLP metrics push: a collector dependency and a push failure that nobody sees; a scrape that fails is visible in the scraper.
- Extracting `traceparent` with a parent-based sampler: still lets an untrusted caller pick ids and force sampling.
- `recordException`: message and stack are free text.
- Log export through OpenTelemetry: a second pipeline that bypasses the allowlist logger.
- Caret ranges for the OpenTelemetry set: one bot bump of an exporter can pull a second core.

## Revisit when

The service is only reachable from a trusted gateway (extract after authentication or add links); the platform mandates OTLP metrics push; the exporters reach a stable 1.x line that tracks the core; or a span attribute or label is needed that is not a closed value.

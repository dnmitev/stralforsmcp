---
status: accepted
---
# The integration suite runs WireMock with mutual TLS through the Docker CLI

The in-process test harness proves unit behaviour, but it cannot prove the stack against a separate TLS endpoint that really rejects a missing or foreign client certificate. Phase 3 adds a second test tier (`npm run test:integration`) that runs the real server and client against a WireMock container with synthetic stubs.

## Decision

1. **The Docker CLI through `execFile`, not the `testcontainers` package.** The helper (`test/integration/docker.ts`) is about 80 lines: run, poll, port lookup, remove. That avoids a dependency tree in the supply chain for what a few lines do, the same reasoning as ADR 0015's decision against the official mcpb CLI. No shell string is ever built; arguments are passed as an array.
2. **The image is referenced by multi-arch index digest** (`wiremock/wiremock` 3.13.2), as ADR 0012 does for the runtime image, so amd64 CI and arm64 laptops run the same release. Tag and digest are bumped together, in one constant.
3. **mTLS is enforced by the container, not by the test.** WireMock starts with `--https-require-client-cert` and a truststore holding only the test CA. A refused client is proven by the request journal on the plain admin port: the refused attempts never appear in it. A certless client is built through the client's agent seam.
4. **Everything secret is generated at run time.** The PKI comes from `generatePki`; a PKCS12 keystore and truststore are built with `openssl` under a random password into a temp dir that only that run mounts, read-only, next to the read-only mappings dir. All of it is removed afterwards; nothing is committed. The truststore carries the JDK trust attribute (`-jdktrust`), otherwise Java loads a certificate-only PKCS12 as an empty trust set and rejects every client.
5. **Loopback only, random ports, unique names.** Both ports (plain HTTP 8080 for the admin API and journal, HTTPS 8443) are published to `127.0.0.1` with host ports chosen by Docker. The container name is `stralforsmcp-it-<random>`. Cleanup runs in `afterAll` and also on `exit`, `SIGINT` and `SIGTERM`, so an interrupted run does not leak containers.
6. **Skip rule.** Without Docker the suite is skipped with one message; if `CI` is set, a missing Docker is an error. A skipped CI job must not look green. The default `vitest.config.ts` excludes `test/integration/`, so `npm run check` needs no Docker.
7. **Scope limits.** Stubs are synthetic and invented (ADR 0004); there are no live vendor calls. The suite checks that our code works against a stub grammar, not that the vendor behaves like it; drift against the live TEST environment is a separate runner.

## Consequences

- The integration tier pulls an image from Docker Hub on first run; unit tests never touch the network.
- Docker's `--keystore-password` flag value is visible in `docker inspect` on the machine for the life of the container. It is a random throwaway that protects nothing beyond that test run.
- CI runs this on Linux and Node 24 only; macOS and Windows runners are out of scope.

## Revisit when

The suite needs several containers or networks (then reconsider `testcontainers`), WireMock 4 leaves beta, or Docker is unavailable on a required runner.

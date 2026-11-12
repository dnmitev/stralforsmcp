---
status: accepted
---
# Distroless Node 26 by digest, source with type stripping, pinned Trivy binary, BuildKit SBOM and provenance, publish only on push

The server needs a reproducible container image for its Kubernetes deployment, with the project metric "zero fixable HIGH or CRITICAL vulnerabilities in the image". Node 24.12 and later run TypeScript source without a flag; Node 26 became the active LTS on 2026-10-28. In March 2026 release artefacts and `aquasecurity/trivy-action` tags were compromised, which showed that the scanner itself is a supply-chain surface. No dependency update bot is configured. Seven related decisions follow.

## Decision

1. **Base images are pinned by digest, bumped by hand.** The final stage is `gcr.io/distroless/nodejs26-debian13:nonroot`, the build stage `node:26-trixie-slim`, each with the index digest after `@` in its `FROM`. The tag stays for readability; the digest decides the bytes. A bump is a reviewed pull request that the image workflow tests. Node 26 was chosen because it is the current LTS; `ci.yml` still runs the source test suite on Node 24 and 26, so the code stays runnable on both while the image ships one.
2. **The image ships source, not a build.** The final stage holds `src/`, `package.json` and the build stage's production `node_modules`; `CMD ["src/server/main.ts"]` relies on Node's native type stripping, and `engines.node` is `>=24.12` for the same reason. The running code is byte-identical to the reviewed source. A compile step (`tsc` or `tsgo`) was rejected: a second artefact to review, source maps, and a parity gap between tests (which run the source) and the image.
3. **Non-root, no shell, no `HEALTHCHECK`, hardening proven not assumed.** The image runs as uid 65532 with files owned by that uid; there is no shell or package manager to add a `HEALTHCHECK` with, and Kubernetes probes on `/healthz` and `/readyz` are the liveness and readiness signal. The smoke test (`scripts/image-smoke.ts`) starts the image with `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges` and `--user 65532:65532`, so a change that needs a writable root filesystem or a capability fails the workflow rather than the cluster.
4. **Trivy is a pinned, checksum-verified binary, not an action.** The workflow downloads `trivy_0.76.2_Linux-64bit.tar.gz` from the release page and runs `sha256sum -c` against a checksum written into the workflow before extracting. `aquasecurity/trivy-action` was rejected: an extra layer of mutable tags that was itself compromised in March 2026. The gate is `--exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed --scanners vuln` on the image plus `trivy config` on the `Dockerfile`. Exceptions exist only in `.trivyignore.yaml` with a `statement` and an `expired_at` at most 90 days ahead, enforced by a test.
5. **SBOM and provenance come from BuildKit on publish, plus a Trivy artifact on every run.** The publish job builds with `sbom: true` and `provenance: mode=max`, so the pushed index carries SPDX and SLSA attestation manifests readable with `docker buildx imagetools inspect`. Every build-scan run also uploads a CycloneDX SBOM and a Trivy table report as the `image-sbom-and-scan` artifact. Signing with cosign and GitHub artifact attestation are deferred, not rejected: nothing in the deployment verifies a signature yet, so the job holds no `id-token` or `attestations` permission.
6. **Publish only on push, from this repository, with per-job permissions.** The workflow's top-level permission is `contents: read`. The `publish` job alone has `packages: write`, runs only when `github.event_name == 'push'` and the repository is not a fork, needs a green `build-scan`, and logs in to GHCR with `GITHUB_TOKEN` only. Tags follow one policy: `sha-<40 hex commit>` always, `edge` on `main`, `X.Y.Z`, `X.Y` and `latest` on `v*` tags only (`flavor: latest=false`). `latest` on `main` was rejected because deployments must not float. The GHCR package is private after the first push; making it public is the maintainer's irreversible action in the package settings, and the workflow never changes visibility.
7. **Multi-arch without emulation.** The publish job builds linux/amd64 and linux/arm64 with no QEMU step: the build stage runs on the build platform (`--platform=$BUILDPLATFORM`) and the dependencies are pure JavaScript, so the arm64 image differs from amd64 only in the base image's arm64 manifest. A dependency update bot was deferred by decision (see "Revisit when"), not rejected.

## What is and is not guaranteed

- A digest pin fixes the bytes, and nothing else. Pins go stale until someone bumps them; the vulnerability metric degrades with them, and no bot or schedule notices.
- The gate reflects Trivy's vulnerability database at build time. `--ignore-unfixed` hides every finding without a fixed version, and the informational report in the artifact is the only place they appear. A finding published after the build is not seen until the next build.
- There is no rescan of the published image. The pull-request gate scans a linux/amd64 image tagged `stralforsmcp:scan`; the publish job rebuilds from the same inputs through the GitHub Actions cache rather than promoting that scanned image, so the pushed digest is not the scanned artefact byte for byte.
- CI never runs the arm64 image. `build-scan` builds and smoke-tests linux/amd64 on `ubuntu-latest`, and builds linux/arm64 as an archive that receives the same Trivy gate but is never started; the arm64 manifest is rebuilt in `publish` and pushed without being started. The arm64 image is smoke-tested only when someone runs `scripts/image-smoke.ts` on an arm64 host, where Docker pulls that platform natively.
- The smoke test proves that the image starts under the hardening flags under Docker. Kubernetes enforces the same constraints again through the pod security context; the test does not replace that.
- The smoke test checks the Node major (`v26` or later) and fails otherwise. A Node minor or patch bump inside a base image digest bump changes the runtime without a code change and passes.
- The image carries no credential or configuration; `STRALFORS_*` and `MCP_*` are file paths and names supplied at run time. The image content check guards against tests, scripts, docs, lock files, key material, a shell or npm landing outside `node_modules`; it does not inspect `node_modules`, where dependencies ship their own test files.
- Provenance states what built the image; it does not prove who. Without a signature, a registry entry can be replaced by anyone with `packages: write`, and nothing downstream would notice.
- The `GITHUB_TOKEN` used to push is scoped to the run; `persist-credentials: false` on checkout keeps it out of the working tree.
- GHCR visibility, tag protection for `v*` and branch protection are repository settings outside this repository.

## Considered and rejected

- Compile with `tsc` or `tsgo`: second artefact, source maps, test-versus-image parity loss.
- `node:*-slim` or Alpine as the final stage: a shell and a package manager inside the running image.
- `aquasecurity/trivy-action`: extra action layers; tags compromised in March 2026.
- cosign or GitHub artifact attestation now: nothing verifies them; deferred until an admission policy does.
- `latest` on `main`: deployments must not float.
- QEMU for arm64: not needed while the build stage runs on the build platform and no native addon exists.
- A `paths:` filter on the workflow: a change outside the filter can still change the image (lock file, source), so every pull request builds.

## Revisit when

An update bot lands (pins become automatic and the bump procedure in the README shrinks); an admission policy verifies signatures (add cosign or artifact attestation with `id-token: write`); a native addon enters the dependency tree (QEMU or arm64 runners, and the arm64 image must be smoke-tested in CI); a post-push rescan or scheduled rescan is added (the "no rescan" gap closes); or start-up time under type stripping matters (a compile step returns as a measured trade-off).

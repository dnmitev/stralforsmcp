---
status: accepted
---
# The Helm chart is published as a signed OCI artifact and a version is never overwritten

Until now the chart could only be consumed from a git checkout at a release tag. Tools that install charts from a registry need a packaged chart with a version that never changes under them.

## Decision

1. **Every `v*` release publishes the chart** to `oci://ghcr.io/<owner>/charts/stralforsmcp`, with the version from `Chart.yaml` `version`. The `chart` workflow packages the chart on every pull request and tag (no secrets, nothing pushed); for a tag, a separate `publish` job pushes that exact package. Pull requests, `main` pushes and forks never publish.
2. **Same release rules as the image.** The tag must be plain `vX.Y.Z` and equal the chart `appVersion` (which follows `package.json`), checked before anything is pushed. `helm` and `cosign` are pinned binaries checked by SHA-256, not installer actions; `id-token: write` and `packages: write` exist only in the tag-gated `publish` job.
3. **A published version is immutable.** GHCR lets a tag be overwritten, so the job looks the version up first and fails if it exists. Publish jobs share one concurrency group across all tags, so two releases cannot both pass the lookup before either pushes. Because `appVersion` changes with every release, the chart `version` must be bumped in every release pull request; a forgotten bump turns the `chart` run red and publishes nothing (the image and extension are unaffected). Fix forward with a new patch release.
4. **The pushed digest is signed keylessly with cosign**, from `chart.yml` at the release tag, exactly like the image (ADR 0024 item 5: the signature says where the package came from, not that it was reviewed). The chart is not scanned: it holds templates only, and the image it points to has its own scan and signature.

## Consequences

- Consumers can install with `helm install ... oci://ghcr.io/<owner>/charts/stralforsmcp --version <x>` and verify the digest with `cosign verify`.
- The lookup treats any failed lookup as "not published". A registry outage at that moment would make the push fail as well, so the residual risk is a lookup that fails while the push succeeds.
- The GHCR package for the chart starts private, like the image package; its visibility is the maintainer's decision.

## Revisit when

The chart gains its own release cadence (separate tags), or GHCR offers immutable tags.

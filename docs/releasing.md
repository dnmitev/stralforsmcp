# Releasing and rolling back

How a release of this server is cut, checked and, if needed, undone. The image, the chart and the Desktop extension share one app version. Placeholders: `<owner>/<repo>`, `<release>`, `<namespace>`, `<digest>`.

A signature proves **where an image came from** (built and scanned by this repository's `image` workflow), not that its code was reviewed: see [ADR 0024](adr/0024-merge-gate-and-release-trust.md) and [Verifying the image](hosting-handoff.md#verifying-the-image).

## Maintainer settings (once, before the first release)

These are repository settings that no workflow in this repository can apply for itself. Record in your private notes who set them and when.

- [ ] **Ruleset for `main`:** pull request required; required checks `check (24)`, `check (26)` and the leak scan (use the names as they appear on a pull request) plus the `review/confidence` status; no bypass for anyone; force-push and deletion blocked.
- [ ] **Code-owner review:** decide and write down. `.github/CODEOWNERS` already names the owner of the trust-bearing paths; *requiring* their review needs a second person, otherwise the author cannot merge their own change. Leave it off with one maintainer.
- [ ] **Ruleset for tags `v*`:** only the maintainer may create, update or delete them; block non-fast-forward. Anyone who can push a `v*` tag can start a publish, and the signature would be valid for it.
- [ ] **GHCR package visibility** (private after the first push; making it public is irreversible and is yours to decide).
- [ ] **Who has maintain or admin access:** only a person with one of those roles can use the `skip-confidence` label (the workflow checks the sender, not just the label), and only on a pull request that touches no gate or pipeline file. Note the one open hole: the docs-only status in `ci.yml` runs from the pull request's own copy of the workflow, so anyone with write access to the repository can post `review/confidence` for their own branch (ADR 0024). Keep write access narrow.

## Cutting a release

1. **Bump the version** in one pull request: `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and the lock file), `version` in `extension/manifest.json` and `appVersion` in `charts/stralforsmcp/Chart.yaml`. `test/release-version.test.ts` fails if one of the four differs. Bump the chart's own `version` too when templates or values changed since the last release (the chart version is independent of the app version).
2. **Merge it** through the normal review. The tag goes on the merge commit.
3. **Tag and push** (annotated; sign the tag if you have a signing key): `git tag -a vX.Y.Z <merge-commit> -m "vX.Y.Z"` then `git push origin vX.Y.Z`. The tag must be plain `X.Y.Z` and equal the `package.json` version; the `image` workflow's first step refuses anything else (`vnext`, `v1.2`, `v1.2.3+x`, a version nobody bumped), before anything is pushed. Prereleases are not published: `main` never carries a prerelease version, so a `-rc` tag is refused.
4. **Watch two runs:** `image` (tag check, build, push, scan of the pushed digest on both platforms, keyless signature) and `mcpb` (build, verify, checksum, attestation). A red `image` run means no signature exists for that digest; fix forward with a new patch version, never move or delete a tag.
5. **Create the GitHub release by hand** (workflows never create releases): download the `mcpb` run's artifact with `gh run download <run-id> -R <owner>/<repo> -n mcpb`, check it (below), then `gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes "..." stralforsmcp.mcpb SHA256SUMS`.

## Checking what was published

Take the digest from the `image` run summary. Image tags published for a release: `X.Y.Z`, `X.Y`, `latest`, plus `sha-<commit>`; `edge` keeps following `main`.

```sh
cosign verify \
  --certificate-identity-regexp '^https://github.com/<owner>/<repo>/\.github/workflows/image\.yml@refs/tags/vX\.Y\.Z$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/<owner>/<repo>@sha256:<digest>

gh attestation verify stralforsmcp.mcpb --repo <owner>/<repo> \
  --signer-workflow <owner>/<repo>/.github/workflows/mcpb.yml --source-ref refs/tags/vX.Y.Z
sha256sum -c SHA256SUMS
```

Tags are mutable pointers: deploy the verified **digest**, never `latest` or `edge`.

## Deploying a release

Set `image.tag` to the version and `image.digest` to the verified digest (the chart README lists every value). TEST and PROD are separate releases with separate Secrets ([hosting handoff](hosting-handoff.md)). Before an upgrade, note the current revision: `helm history <release> -n <namespace>`.

## Rolling back

1. `helm history <release> -n <namespace>`: note the last good revision.
2. `helm rollback <release> <revision> -n <namespace>`, or redeploy the previous verified digest through your pipeline.
3. Wait for the rollout; check `/readyz`, `stralfors_up` and one tool call ([runbook](runbook.md#rolling-back)).

A rollback does **not** undo: Secrets (restore them from your secret store), a token that was already revoked or issued, a Desktop extension that users already installed, or a tag. A bad release is **superseded by a new patch version**, not removed: tags are never moved or deleted, and a published GHCR version is deleted only by the maintainer and only for a reason that is written down.

## Rehearsal record

Run one upgrade and one rollback on TEST before the first production use of a version, and record it (private notes are fine):

| Date | From revision | To revision | Rolled back to | `/readyz` and `stralfors_up` after each step | One tool call worked | Surprises |
|---|---|---|---|---|---|---|
| | | | | | | |

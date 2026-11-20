---
status: accepted
---
# Merge gate ownership, the skip label and release trust

An audit found that the merge gate (the `review/confidence` status) is written and posted from inside the trust domain it protects, and that no release procedure existed. This ADR records what is owned, the one accepted `pull_request_target` workflow, and how a release is trusted.

## Decision

1. **Code owners.** `.github/CODEOWNERS` names the maintainer for the paths that carry trust: `.github/`, `.claude/`, `scripts/`, `Dockerfile`, `.dockerignore`, the scanner and review configs, `charts/`, `extension/`, `docs/adr/`, `package.json` and `package-lock.json`. A test keeps those paths covered. Whether a code-owner review is *required* is a repository setting, and it stays off while there is one maintainer: the author could not approve their own change. It becomes useful with a second operator.
2. **One accepted `pull_request_target` workflow.** `skip-confidence.yml` lets a maintainer skip the confidence gate for one head commit by adding a label (adding a label needs triage access, so the label is the authorisation). `pull_request_target` runs with the base branch's code and a token with write access, so the workflow is held to strict rules that a test enforces: it is allowed only under that file name; top-level `permissions: {}`; its job may only hold `pull-requests` and `statuses`; no checkout; no `${{ }}` expression in a `run:` body (values come through `env:`). It reads the changed-file list through the API (data, never executed). Every other workflow with that trigger still fails the policy test.
3. **The skip refuses where the gate lives.** If the pull request changes `.github/`, `.claude/`, `scripts/`, `Dockerfile`, `charts/` or the scanner and review configs, the label does nothing. A listing error, an incomplete listing or a head that moved since the event also refuses. A new push drops the label, and a status belongs to one commit, so the next commit needs a new review or a new label.
4. **What this does not defend against.** A maintainer who misuses the label, or a compromised maintainer account, can still set the status: the label is a convenience for the person who already holds the merge right, not a second reviewer. The documentation-only shortcut in `ci.yml` has the same shape (no checkout, data-only reads) and is left as it is.
5. **A signature says where an image came from, not that it was reviewed.** `latest` and the version tags are published only for a strict semver tag whose version equals `package.json` (a failing tag check stops the run before anything is pushed), and a prerelease never gets `latest`. Anyone who can push a `v*` tag can still start a publish, so a tag ruleset limiting who may create, update or delete `v*` tags is part of the release procedure (`docs/releasing.md`).

## Not covered

- Required code-owner review and a second operator.
- Moving the signature into a job of its own (the publish job holds `id-token: write` together with its pinned actions; see the hosting handoff).
- Attesting the `.mcpb` only for a checked tag (the attest job runs for any `v*` tag; the maintainer creates the release by hand, and the image job is the one that refuses a bad tag).

## Revisit when

A second maintainer joins (turn on code-owner review), a gate-bearing path is added, or the skip label is used for something other than a bot bump.

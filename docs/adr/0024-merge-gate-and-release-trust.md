---
status: accepted
---
# Merge gate ownership, the skip label and release trust

An audit found that the merge gate (the `review/confidence` status) is written and posted from inside the trust domain it protects, and that no release procedure existed. This ADR records what is owned, the one accepted `pull_request_target` workflow, and how a release is trusted.

## Decision

1. **Code owners.** `.github/CODEOWNERS` names the maintainer for the paths that carry trust: `.github/`, `.claude/`, `.githooks/`, `scripts/`, `Dockerfile`, `.dockerignore`, `.gitignore`, the scanner and review configs, the lint, Node version, Vitest, Stryker and TypeScript configs, `charts/`, `extension/`, `docs/adr/`, `package.json` and `package-lock.json`. A test keeps those paths covered. Whether a code-owner review is *required* is a repository setting, and it stays off while there is one maintainer: the author could not approve their own change. It becomes useful with a second operator.
2. **One accepted `pull_request_target` workflow.** `skip-confidence.yml` lets a maintainer skip the confidence gate for one head commit by adding a label. Adding a label needs triage access, but an installed app with the right permission can add one too, so the workflow checks the sender itself: a person (not an app) with maintain or admin permission; any doubt refuses. `pull_request_target` runs with the base branch's code and a token with write access, so the workflow is held to strict rules that a test enforces: it is allowed only under that file name; top-level `permissions: {}`; its job may only hold `pull-requests` and `statuses`; no `uses:` step at all (so no checkout and no action that checks out inside), no `git` or `gh pr` in a `run:` body, `${{ }}` only as an `env:` value or in an `if:`, no `secrets.` reference, and `pull_request_target` as the only trigger. It reads the changed-file list through the API (data, never executed). Every other workflow with that trigger still fails the policy test.
3. **The skip refuses where the gate lives.** If the pull request changes `.github/`, `.claude/`, `.githooks/`, `scripts/`, `extension/`, `Dockerfile`, `charts/`, `.gitignore`, the scanner, review, lint, Node version, Vitest, Stryker or TypeScript configs, or the `scripts` block of `package.json`, the label does nothing. The check lists the files between the base and head commits named in the event (commit SHAs cannot move under it, so a force-push during the run changes nothing), and a listing error or a possibly incomplete listing refuses. The sender's role is read from the collaborators API (`role_name`). A refusal removes the label and says why in the run summary. A new push drops the label, and a status belongs to one commit, so the next commit needs a new review or a new label.
4. **What this does not defend against.** A maintainer who misuses the label, or a compromised maintainer account, can still set the status: the label is a convenience for the person who already holds the merge right, not a second reviewer. **The documentation-only shortcut in `ci.yml` is a hole this ADR does not close.** It runs under `pull_request`, so a pull request from a branch in this repository runs its own edited copy of `ci.yml` with `statuses: write` and can post `review/confidence` for its own head. Fork and Dependabot tokens are read-only, so it needs write access to the repository. Closing it means moving that status into a base-branch workflow (a later plan); until then the protection is who has write access.
5. **A signature says where an image came from, not that it was reviewed.** `latest` and the version tags are published only for a strict semver tag whose version equals `package.json` (a failing tag check stops the run before anything is pushed), and a prerelease never gets `latest`. Anyone who can push a `v*` tag can still start a publish, so a tag ruleset limiting who may create, update or delete `v*` tags is part of the release procedure (`docs/releasing.md`).

## Not covered

- The `ci.yml` docs-only status described in item 4.
- Required code-owner review and a second operator.
- Moving the signature into a job of its own (the publish job holds `id-token: write` together with its pinned actions; see the hosting handoff).
- Attesting the `.mcpb` only for a checked tag (the attest job runs for any `v*` tag; the maintainer creates the release by hand, and the image job is the one that refuses a bad tag).

## Revisit when

A second maintainer joins (turn on code-owner review), a gate-bearing path is added, or the skip label is used for something other than a bot bump.

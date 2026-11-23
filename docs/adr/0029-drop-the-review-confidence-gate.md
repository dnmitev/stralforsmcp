---
status: accepted
---
# Drop the review/confidence gate; green CI and the Greptile review gate merges

The `review/confidence` commit status (ADR 0024) was posted by the principal-reviewer agent, by the `skip-confidence` label workflow and by `ci.yml` for documentation-only pull requests, and the `main` ruleset required it. In practice Greptile reviews every pull request and its findings are fixed before merge, so the extra status mostly added waiting: Greptile does not review Dependabot pull requests, the agent capped those below the threshold, and the label refused gate files, so routine base image bumps could not pass without a manual workaround.

## Decision

1. **No confidence status.** Nothing posts `review/confidence`, and the `main` ruleset no longer requires it. Required checks are `check (24)`, `check (26)` and `leak-scan`.
2. **The skip label and its workflow are removed.** With them goes the only `pull_request_target` workflow, so the workflow policy test now forbids that trigger everywhere, without exception.
3. **`ci.yml` keeps only the mutation scope check.** The documentation-only status and its `statuses: write` permission are gone, which also closes the hole ADR 0024 item 4 described (a branch could post the status for itself).
4. **The principal review stays, as advice.** The agent still reviews at phase end or on demand and reports a score, but posts no status.

## Consequences

- A pull request merges once CI is green; fixing valid Greptile findings is the maintainer's discipline, not a check.
- The code-owner paths, the release rules and the image signing of ADR 0024 (items 1 and 5) are unchanged.

## Revisit when

A second maintainer joins (consider requiring a code-owner review), or Greptile stops reviewing pull requests.

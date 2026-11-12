---
status: accepted
---
# Policy rules run in a fixed order and a write in prod is denied by a constant

The policy evaluates one tool call as environment, then role, then write, then validate (see the note below), then scope; the first failing rule is the single reason reported. The denial of any write-level tool in `prod` is a literal in the policy with no configuration input, so no flag, token list entry or scope can enable it; the `allowWrite` setting only matters in `test`. Fixed order keeps the reason code deterministic for audit and tests, and the constant means that opening prod writes is a code change that goes through review, not a deployment setting that could be flipped by mistake. Switching to a configurable rule set later would require re-deriving every reason-code expectation in the audit trail.

_Note, 2026-11-12: a validate rule now sits between write and scope. A validate-level tool in `prod` is denied with reason `validate` unless the prod-validate setting is on; the write constant is unchanged._

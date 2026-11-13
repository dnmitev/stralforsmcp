---
status: accepted
---
# Rule hints are fixed templates; structured rule metadata may pass through, vendor messages never do

`get_rules` turns the rules a channel publishes into readable hints, and `validate_invoice` (the next plan) will report findings in the same words. The rules arrive as free-text criteria and error values written by the vendor. Error messages from the API already carry identity data, so ADR 0002 keeps all upstream message text away from callers. Rules are different: they describe the contract, not a request, and they are what a caller needs to read.

## Decision

1. **Every hint is a fixed sentence template per criterion kind**, filled with parameters parsed from the criterion (path, number, value list, field name). A criterion the parser does not know becomes the `unknown` kind with a fixed sentence that names the rule id and carries no vendor text.
2. **Published rule metadata may pass through** because it is contract data, not request data: patterns, example values, allowed-value lists (capped at 20 plus a count), field names in "cannot be combined with" and dependency rules, and the expression or prose of the four conditional and note kinds (`optional_when`, `required_when`, `invalid_when`, `criteria`). Known note codes get fixed glosses.
3. **Vendor messages never pass**: error messages, explanation text, exception text and anything that does not match the criterion grammar are dropped. The rule id is kept so a caller can look the rule up.
4. **The pass-through strings are watched.** The drift tests planned for the integration suite compare them against the live rules, so a new shape is noticed before it reaches callers.

## Consequences

- A new vendor criterion kind shows up as `unknown`, not as raw text; adding its template is a code change with a test.
- The one place vendor prose reaches a caller is the four expression kinds. If a rule ever carries an identifier there, the fix is to replace that kind with a fixed sentence.
- Hints are English only.

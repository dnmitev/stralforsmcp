---
status: accepted
---
# Validate findings are fixed templates; the local check never blocks on uncertainty; the dry run is authoritative

`validate_invoice` explains why an invoice document would be refused, before it is sent. It combines input shape checks, an interpreter over the published rules, and the API's own dry run. The first two are an approximation of the third, and the API's error values carry free text that ADR 0002 keeps away from callers.

## Decision

1. **Stages run in order and stop at the first with findings**: input shape, local check, dry run. A result names the stage that produced its findings.
2. **Every finding is a fixed sentence per criterion kind** (ADR 0016), filled with parsed parameters. Error messages, explanation text, exception text and anything outside the criterion grammar are dropped. A rule-engine failure becomes one fixed sentence that names the rule id and says the fault is not in the document.
3. **The local check only reports what it is certain of.** It stops the dry run, so a false finding would block a valid document. A rule is skipped when an ancestor of its path is absent from the document, when it is conditional, when its pattern or bound cannot be parsed, or when its kind is unknown. Allowed-value comparisons ignore case here; exact casing is the dry run's decision.
4. **The dry run is authoritative.** `valid: true` is returned only after it accepts the document and no finding exists. One dry-run round per call; `moreMayFollow` is true whenever the result is not valid, because faults arrive per layer.
5. **Nothing identifying is returned or recorded**: the identifier the dry run echoes, the consignment identifier (generated when absent), the agreement identifier and the document content never reach the result, the audit line, logs or spans.
6. **The tool is a validate-level tool**: hidden and denied in PROD unless the dry run is enabled there. It declares no scope.

## Consequences

- The local check can miss a problem the dry run then finds; the caller sees it in a second call.
- Findings are capped at 100 per result with a final marker, so one badly broken document cannot exceed the output cap.
- A rules fetch failure degrades the local check to a fixed finding without blocking the dry run, and never produces `valid: true`.

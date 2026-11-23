---
status: accepted
---
# Validate findings are fixed templates; the local check never blocks on uncertainty; the dry run is authoritative

`validate_invoice` explains why an invoice document would be refused, before it is sent. It combines input shape checks, an interpreter over the published rules, and the API's own dry run. The first two are an approximation of the third, and the API's error values carry free text that ADR 0002 keeps away from callers.

## Decision

1. **Stages run in order and stop at the first with findings**: input shape, local check, dry run. A result names the stage that produced its findings.
2. **Every finding is a fixed sentence per criterion kind** (ADR 0016), filled with parsed parameters. Error messages, explanation text, exception text and anything outside the criterion grammar are dropped. A rule-engine failure becomes one fixed sentence that names the rule id and says the fault is not in the document.
3. **The local check only reports what it is certain of.** It stops the dry run, so a false finding would block a valid document. A rule is skipped when an ancestor of its path is absent from the document, when it is conditional, when its pattern or bound cannot be parsed, or when its kind is unknown. Allowed-value comparisons ignore case here; exact casing is the dry run's decision.
   *Amended 2026-11-21.* A pattern is also skipped when it uses syntax of the vendor's .NET regex dialect that JS rejects or reads differently (inline options, comments, atomic, conditional and balancing groups, quoted group names, `\A` `\Z` `\z` `\G`, Unicode properties `\p{…}` `\P{…}`, character-class subtraction `[a-z-[aeiou]]`), and for one value when the two engines disagree on it: a shorthand class or word boundary (`\w` `\d` `\b` `\s` and their negations) against a non-ASCII value, or an end anchor against a value ending in a line feed. Local findings stop the dry run only when the document lists exactly one channel and that channel's rules were fetched at most 5 minutes ago; with several channels (the vendor applies one channel's rules, not their union) or older cached rules, the dry run decides. A `templateParameter.standardId` that is present but not a whole number from 0 to 1,000,000 is a shape finding, not a silent template 0.
   *Amended 2026-11-23.* The list mark (`ArrayExpected`, `ArrayWithValidItemsExpected`) is never checked locally. The vendor puts it on string fields inside lists and on some string fields of plain objects, so a local "must be a list" finding would block a correct document and push the caller to a shape the API cannot read. The `get_rules` hint says the field is marked as a list and points to the example invoice.
4. **The dry run is authoritative.** `valid: true` is returned only after it accepts the document and no finding exists. One dry-run round per call; `moreMayFollow` is true whenever the result is not valid, because faults arrive per layer.
5. **Nothing identifying is returned or recorded**: the identifier the dry run echoes, the consignment identifier (generated when absent), the agreement identifier and the document content never reach the result, the audit line, logs or spans.
6. **The tool is a validate-level tool**: hidden and denied in PROD unless the dry run is enabled there. It declares no scope.
7. **The dry run must prove it was one.** The response carries an `isTest` flag. In PROD the tool returns `valid: true` only when it is `true`; an empty or flag-less answer is refused as a schema error with fixed text. In every environment an explicit `false` is refused. In PROD the tool is annotated as not read-only, because its route is a write verb whose safety rests on the vendor honouring `test=true`. Enabling the PROD dry run additionally needs a recorded vendor confirmation of that behaviour.

## Consequences

- The local check can miss a problem the dry run then finds; the caller sees it in a second call.
- A multi-channel document, or one checked against rules cached for more than 5 minutes, gets the dry run's findings instead of the local sentences; a vendor relaxation never blocks a valid document for the cache TTL.
- Findings are capped at 100 per result with a final marker, so one badly broken document cannot exceed the output cap.
- A rules fetch failure degrades the local check to a fixed finding without blocking the dry run, and never produces `valid: true`.

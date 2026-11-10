---
status: accepted
---
# Error messages are fixed text; raw upstream fault data is kept but non-enumerable

The API's error bodies embed identity ids, agreement ids and request ids in free text, so copying `message` or `explanationText` into an error, a log or a tool result leaks identifiers. We decided that every client error carries a fixed, hand-written message plus a stable `kind`, and that the raw upstream material (`faults`, `errors`, `detail`, `actionId`) stays readable by property name but is non-enumerable, so spreads, `Object.keys`, `JSON.stringify` and `util.inspect` never copy it. The alternative, redacting upstream text with patterns, was rejected because a new identifier format would leak until noticed.

## Consequences

- Consumers branch on `kind` and parsed `violations`, never on message text.
- Anyone "fixing" the hidden properties to make debugging easier reopens the leak; the canary tests exist to stop that.

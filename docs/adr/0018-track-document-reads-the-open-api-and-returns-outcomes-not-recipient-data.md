---
status: accepted
---
# track_document reads the open Track & Trace API and returns outcomes, not recipient data

`track_document` answers "what happened to this invoice". The vendor tracks documents in an internal database that its production systems fill through a SOAP registration service, and exposes the same records read-only through an open REST API. The records carry recipient names, addresses and free-text comments.

## Decision

1. **The open REST API, never the SOAP service.** The tool only issues GET requests against the Track & Trace open API. Registration is the vendor's job. EDI tracking is out of scope: it serves customers that submit EDI files directly, not Omni integrations.
2. **The PROD read allowlist grows by exactly two paths**: the document lookup and one document's delivery history (document id of one to ten letters and digits, matched on the parsed path). File endpoints, other sub-paths and every other method stay refused.
3. **The output is built from an allowlist of fields.** Recipient data, customer numbers, file ids, additional data and comment text are never picked, so a field the vendor adds later cannot leak. A history event message is kept only if it is exactly one of the known status names (the exact names of the channel status table, not its prefix groups, which would let "Printing for <name>" through); otherwise the event keeps its time and loses the message.
4. **The outcome is a fixed mapping of our own.** Per channel it is looked up from the raw status (case and whitespace ignored, a few prefix groups); anything unknown is `unknown` and the raw status is always returned beside it. The document outcome is derived from its channels: delivered wins, in progress or unknown beats refused, refused beats failed. A history that reports all delivery documents delivered forces `delivered`.
5. **404 is `not_found` until the maintainer's TEST check (V-8) shows whether it means "no match".** If it does, a 404 on the lookup becomes an empty list. A gateway 404 for an unknown route stays `route_not_found`. The audit line shows reason `bad_input` for a 404 for now, because the client classifies a JSON 404 as an agreement problem and the shared tool wrapper is unchanged.
6. **One read per call, no polling, no caching.** Status changes take hours to days; the answer carries `checkedAt` so the reader knows how fresh it is. Keys, cursors and ids are never logged, traced or audited.

## Consequences

- The outcome table can disagree with the vendor's wording; the raw status lets the reader judge, and unknown statuses are visible rather than guessed.
- Several documents can match one invoice number, so the result is a list with a cursor.
- A dedicated `not_found` error kind replaces the `bad_input` audit reason once V-8 settles what a 404 means.

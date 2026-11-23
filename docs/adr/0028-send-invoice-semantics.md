---
status: accepted
---
# send_invoice: TEST only, one exact route, never replayed, and its outcome always known

Phase 6 adds the first tool that creates something at the vendor: sending an invoice. A send cannot be undone, the vendor de-duplicates on the client-chosen `consignmentId` only when told the same id, and ADR 0026 aborts a request whose caller cancels, which for a create leaves the outcome unknown. These decisions are fixed before the tool is built.

## Decision

1. **TEST only, by construction.** The tool is a write-access tool: the policy denies it in PROD as a constant (ADR 0007) and hides it on TEST unless `STRALFORS_ALLOW_WRITE=true`. The client's write guard opens exactly `POST <apiomni>/v2/invoices/true` with no query when that flag is on, and nothing else (ADR 0001, amended 2026-11-22).
2. **The write scope comes from the real token.** A request's claims hold `apiomni.write` when any profile's last fetched Stralfors token holds it; with writes allowed every profile's token is fetched once at startup. The tool re-checks that the profile the caller chose holds `apiomni.write` and refuses with fixed text before any request otherwise.
3. **A client-supplied `consignmentId` is required.** The caller passes it; the server never generates one, so a caller who retries reuses the same id and the vendor can recognise the duplicate (`409`).
4. **Never replayed, never retried.** The send uses the client's `noReplay` (a `401` invalidates the token but the request is not sent a second time), and there is no automatic retry after a timeout, a network error or a `5xx`.
5. **The send runs detached once started.** A caller cancel or dropped connection does not abort a send that has started (the request runs outside the caller's abort scope, ADR 0026's shared-work rule); the caller stops waiting, and the outcome is still recorded in the audit line. A slow send keeps its cap slot until the request timeout.
6. **One reported outcome per call:** `sent` (the vendor accepted it), `rejected` (a vendor refusal with findings, as for validate, or `409` for a reused `consignmentId`), or `unknown` (timeout or network failure after the body may have arrived). `unknown` tells the caller to check with `track_document` using the same `consignmentId` or invoice number, never to send again with a new id.

*Amended 2026-11-23, while building the tool:*

7. **No local rules check before a send.** The vendor decides; `validate_invoice` is the pre-check. A local block would add a second, weaker authority on an irreversible path.
8. **`unknown` only once the send itself has started.** A failure while fetching the token comes before any request is sent, so the call fails with its error kind instead. An unreadable answer after a 2xx still counts as `sent`.
9. **A duplicate stays `rejected` but says "do not send again".** It is usually a retry after `unknown`, so its hint must never invite a new send, not even under a new `consignmentId`.
10. **Item 6 corrected: a send is followed by invoice number.** Track & Trace does not know the `consignmentId`, so `track_document` looks a send up by invoice number only. A send can take a while to appear there; an empty answer soon after does not mean it was lost.

## Considered options

- **Abort a started send on caller cancel, like every other request.** Frees the slot at once and stays uniform with ADR 0026, but every cancel then leaves an outcome nobody knows. Rejected: for an irreversible create, a known outcome is worth more than a freed slot.
- **Automatic retry with the same `consignmentId`.** Safe only if the vendor's duplicate detection is guaranteed for every channel; it is not documented. Rejected until the vendor confirms it.
- **Server-generated `consignmentId`.** Makes a client retry indistinguishable from a new send. Rejected.

## Consequences

- A send keeps running after its caller left; the cap counts it until it finishes or times out.
- A timeout gives `unknown`, and only `track_document` can settle it.
- PROD never gains this tool or route; enabling it is not a configuration change.

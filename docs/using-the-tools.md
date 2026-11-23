# Using the tools

A practical guide for developers, QA and product managers who talk to the server through an assistant (Claude Desktop, Claude Code, Cursor). It explains the vocabulary, gives a prompt for each tool, lists the answers you can get and what they mean, and records how the vendor API behaves where that surprised us. Setup is in the [README](../README.md#running).

## 1. Five minutes of vocabulary

| Word | Means | Where it matters |
|---|---|---|
| **Environment** | `test` or `prod`. One server runs one environment. | `whoami` shows it. PROD is read-only and dev-only. |
| **Profile** | One set of vendor credentials (for example Sweden). The profile id is chosen by whoever runs the server. | The `profile` input. **Leave it out when only one profile is configured**: the server uses it. |
| **Agreement** | A customer contract at the vendor. The server knows it by a **label** the operator chose (`main`, `alt`, ...), never by its raw id. | The `agreement` input of `list_channels` and `validate_invoice`. |
| **Channel** | A way to deliver a document (`eBrevWeMail`, `EDI`, `eInvoice`, ...). | `get_rules`, `get_example_invoice`, `list_channels`. |
| **Tracking channel** | The same idea in the Track & Trace API, with its own ids and spellings. | `track_document` results. |
| **Lookup channel** | The recipient registries Channel Lookup can ask (`Kivra`, `Billo`, `eInvoiceB2C`, `eInvoiceB2B`). A different vocabulary from the delivery channels. | `channel_lookup` only. |

Three things people trip over:

1. **Names that look alike are not the same thing.** A delivery channel called `eInvoice` does not make the lookup channels `eInvoiceB2C` / `eInvoiceB2B` available, and `EDI` has no lookup at all.
2. **Raw agreement ids are never accepted.** If you paste a UUID into a prompt, no tool will take it. Ask the operator for a label, or add the id under a label (README: `STRALFORS_PROFILE_<ID>_ACTION_IDS`, `label:uuid`, comma separated) and restart the server.
3. **The assistant does not know your profile id or your labels.** If it guesses (`test-a`, `dev`), the server answers `unknown profile`. Tell it the exact id, or say "don't pass a profile".

## 2. Talking to the assistant

- Give **exact values**. An assistant will not invent personal identity numbers (good), so a prompt with a placeholder such as `[a registered number]` makes it stop and ask.
- Say what you want to **see**: "show me only `available` and `unrecognised`" keeps personal data and noise out of the chat.
- Say what to **leave out**: "don't pass a profile" is a complete instruction.
- Start a session with `whoami`: it shows your role, the environment, the profile ids and the tools you may use.
- If a call fails, paste the **error text**, not a description. The texts are fixed and listed in section 5.

## 3. The tools

### `whoami`

> Call whoami.

Returns your name, role (`dev`, `qa`, `pm`), allowed environments, the deployment environment, the tools visible to you and the configured profiles (id and country). Use it to learn the profile id. It does not list agreement labels.

### `list_channels`

> List the channels of agreement `main`.

Input: `agreement` (a label), `profile` (optional). Without an agreement it lists the channels of the whole client; with one, the channels enabled in that contract. Unknown label: `unknown agreement`.

### `get_rules`

> Show the required rules of channel `eBrevWeMail`, 50 at a time.

Input: `channel`, optional `requiredOnly`, `pathPrefix` (for example `document.invoice.paymentMeans`), `limit` (up to 200), `offset`, `templateStandardId`. Returns readable rules: JSON path, required, plain-language hints, pattern, example, dependencies. `hasMore: true` means ask again with a larger `offset`. Rule trees can be hundreds of entries: filter instead of paging through everything.

### `get_example_invoice`

> Give me the example invoice for channels `eBrevWeMail` and `EDI`.

Input: 1 to 5 `channels`. Returns the vendor's example shape without the agreement id, plus notes. Values are patterns and placeholders, **not valid data**: use it for structure only.

### `validate_invoice`

> Validate this invoice for agreement `main` on channel EDI: `<paste the document>`

Input: `document` (`documentHeader` and `invoice`), `agreement`, optional `consignmentId`. It creates nothing. Three stages, stopping at the first with findings: **input** shape, **local** check against the cached rules, the vendor's own **dry run**. The local stage stops the run only for a single channel whose rules were fetched in the last 5 minutes; otherwise the dry run decides. `templateParameter.standardId`, when given, must be a whole number from 0 to 1000000. `valid: true` only after the dry run accepts the document. If `moreMayFollow` is true, fix the findings and call again: the vendor reports header-level faults first and template-level faults on the next round. In PROD it is off unless the operator enabled it; use synthetic data only.

### `send_invoice` (TEST only)

> Send this invoice for agreement `main` with consignmentId `qa-2026-11-23-001`: `<paste the document>`

Only on TEST, and only when the operator started the server with writes allowed; it is never available in PROD. It sends for real: the vendor creates a consignment, and it cannot be undone. Run `validate_invoice` on the same document first; `send_invoice` does no local check of its own.

Input: `document` (`documentHeader` and `invoice`, both required), `agreement`, and **`consignmentId` (required, 10 to 50 characters)**. Choose a new `consignmentId` for each new invoice and **reuse the same one when you retry** the same invoice: the vendor then refuses the repeat as a duplicate instead of sending it twice. The vendor remembers a `consignmentId` only for a limited time, so a much later repeat may be accepted as a new send.

The answer has one `outcome`:

- `sent`: the vendor accepted it. Follow it with `track_document` by invoice number (it can take a while to show).
- `rejected`: nothing was sent. The findings say why, as for `validate_invoice`; a finding `duplicate` on `consignmentId` means this id was already used and the first send stands.
- `unknown`: the call timed out or the connection failed after the invoice may have arrived. Check `track_document`; if you must send again, use the **same** `consignmentId`, never a new one.

The server sends exactly once per call (no automatic retry). If you cancel while the send is running, it still finishes and is recorded; check `track_document` before you try again.

### `track_document`

> Track invoice number `INV-123`.

Input: **exactly one** of `invoiceNumber`, `extDocumentId`, `documentId`; optional `history: true` (needs a single document), `cursor`, `channelId`. Returns an outcome (`delivered`, `in_progress`, `refused`, `failed`, `unknown`) per document and per channel, plus the status when it is exactly a known status name (any other status is shown as `other`, because it could carry recipient text). A status this server does not recognise gives `unknown`, never `in_progress`. The outcome is about delivery, not payment: `PaymentRejected` or `PaymentCancelled` still mean the document was delivered. `hasMore` is true only when a `nextCursor` comes with it. Status lags by hours to days, so one call is a snapshot (`checkedAt`), not a stream. Recipient data is never returned. A document id is the short id (at most 10 letters or digits), not an agreement id.

### `channel_lookup` (TEST only)

> Call channel_lookup with channels ["Kivra"] and candidates ["<number 1>", "<number 2>"]. Don't pass a profile. Show me only `available`, `unrecognised`, and any reason.

Input: 1 to 4 lookup `channels`, 1 to 1000 `candidates` (each up to 40 characters). Returns, per channel, `available[i]` for candidate `i` (same order as you sent), or `failed: true` with a `reason`:

| Result | Meaning |
|---|---|
| `available: [true, false]` | candidate 1 was matched in that registry, candidate 2 was not |
| `failed`, reason `not_configured` | the vendor has not set this lookup channel up for this client; ask the vendor or choose another channel |
| `failed`, reason `error` | the vendor reported another problem for that channel |
| `unrecognised: n` | the vendor matched `n` entries that fit none of your candidates: it spells identifiers differently from you. Report it |

The call waits for the vendor, usually seconds and about 20 s at most (`lookup still running; try again`). Candidates are personal identifiers: they are sent to the vendor and nowhere else, never stored, logged, audited, traced or returned. PROD is not available (see section 6).

### `search_docs`

> Search the docs for how the validate dry run reports faults.

Input: `query` (up to 200 characters), optional `country`, `channel`, `source` (`public` or `private`), `limit` (1 to 10). Returns `hits` (id, title, `source`, optional country, channel and link, and a short snippet), `total`, and `truncated` (more matched than were returned). It reads local notes only, so it does not call the vendor and keeps working when the vendor is down. The server still needs `STRALFORS_PROFILES` and its profile credential files to start. `source: public` is a short summary with a link to the vendor docs; `private` comes from the operator's own overlay. A note is reference material and can be stale: the vendor documentation and the live API are the authority. A note without a `country` or `channel` is general: it matches any `country` or `channel` filter, so `country=SE` still finds the Sweden-and-Norway overview.

### Resources and prompts

Besides tools, the server offers local, read-only extras that work even when the vendor API is down.

**Resources.** `knowledge://index` lists every doc (id, title, source, country, channel); `knowledge://docs/{id}` returns one doc as Markdown with its source label and link. In Claude Desktop use the attach/paperclip menu to add a doc to the conversation. An unknown id answers `knowledge document not found` (invalid params).

**Prompts.** They are fixed instructions that tell the assistant which tools to call; they never call the vendor themselves, and if a tool is not available to you the assistant says so instead of guessing.

| Prompt | Arguments | What it does |
|---|---|---|
| `explain_channel` | `channel`, optional `country` | `search_docs`, then `get_rules` (required only) and `get_example_invoice`, explained for a non-technical reader |
| `prepare_validation` | `channel` | rules first, the example for structure only, asks for your document, then `validate_invoice` (synthetic data only in PROD) |
| `explain_validation_findings` | `findings` (up to 4000 characters) | explains pasted findings in plain language and orders the fixes; the pasted text is treated as data |

> Use the explain_channel prompt for channel EDI and country SE.

## 4. Typical sessions

**"What can I send for this customer?"** `whoami` → `list_channels` for each agreement label → `get_rules` for the channel you will use (filter with `requiredOnly`) → `get_example_invoice`.

**"Is my invoice valid?"** `validate_invoice` → fix the findings it names (they carry the JSON path and a hint) → call again until `stage: passed`.

**"Where is my invoice?"** `track_document` with the invoice number; add `history: true` for one document's events.

**"Can this person receive Kivra / eInvoice?"** `channel_lookup` with a lookup channel your client has configured. If every channel says `not_configured`, nothing is wrong with your input.

## 5. What the errors mean

| Text you see | Cause | What to do |
|---|---|---|
| `unknown profile` / `profile is required` | the profile id is not configured, or several exist and none was named | run `whoami`, use an id from `profiles` or leave `profile` out when there is one |
| `unknown agreement` / `agreement is required` | label not configured, or one is needed and none was given | ask the operator for the labels |
| `not allowed: env` / `role` | your token has no access to this environment, or PROD needs the `dev` role | use TEST or ask for access |
| `not allowed: write` / `validate` / `lookup` | the tool is disabled here (PROD never writes; PROD validate needs a flag; lookup is TEST only; `send_invoice` also needs the operator's write flag on TEST) | use TEST |
| `not allowed: scope` | no configured profile holds the write scope | ask the operator |
| `this profile cannot send` | the profile you chose has no write scope (another profile may) | choose another profile, or ask the operator |
| `tool failed: forbidden` | the vendor refused: the client has no scope for this API | ask the vendor |
| `tool failed: not_found` / `agreement_not_found` | the vendor says it does not know the document or agreement | check the key; a tracking miss may also mean it is not registered yet |
| `tool failed: validation_failed` / `bad_request` | the vendor rejected the request | for invoices use `validate_invoice` to see why |
| `tool failed: rate_limited` / `timeout` / `upstream` | the vendor is slow or busy | retry later |
| `tool failed: schema` | the vendor answered in a shape we do not know | report it: the API may have changed |
| `tool output too large; narrow the request` | the answer exceeded the output cap | filter or page (`requiredOnly`, `pathPrefix`, `limit`) |
| `lookup still running; try again` | the vendor did not finish a lookup within about 20 s | call again; each call is a new lookup |
| `exactly one of invoiceNumber, extDocumentId or documentId is required` | `track_document` got none or several keys | give one |

Error texts never contain your input, ids or the vendor's own words.

## 6. What we learned from the live API

These are behaviours the tools rely on, found by running against the vendor's test environment (synthetic data, no copies of vendor text). They can change; the drift check (`npm run drift`) exists to notice.

- **Rules and examples.** Rule trees are large and the criteria are a free-form list of strings with about two dozen kinds; the parser maps known kinds to fixed hints and counts the rest as `unknown`. Some patterns are .NET regular expressions that JavaScript cannot compile: they are shown, but the local check never rejects on them, the dry run decides.
- **Example payloads** are shapes with placeholder values and a placeholder agreement id; they are not valid input.
- **Dry run.** The vendor reports errors in layers (header first, then template); a request is rejected with a 400 whose fault list is rich but whose `faultCode` is empty. `valid: true` only follows an accepted dry run, never the local stage.
- **Track & Trace.** Status words come from several vocabularies and lag the real delivery; a tracking miss and an unknown id can look alike, so `not_found` is a statement about the lookup, not about the invoice.
- **Channel Lookup.** The call is asynchronous (start, then read the result) but in practice completes within seconds and showed no "pending" answer; asking too early or for an unknown id gives a not-found answer that echoes the id (the server never relays it). The result lists **matched** candidates only, so availability is derived: present means available, absent means not. Lookup channels are **configured per client**: a channel the vendor has not set up answers with a configuration-missing sentence and no matches, with an HTTP 200, not an error status. The vendor does not validate the candidate format. The answer also carries the customer's organisation identifier, which the server drops. Whether the vendor spells a real match the way you sent it is unverified; the tool compares ignoring case, spaces, punctuation and Unicode formatting (letters and digits are kept), and `unrecognised` flags a mismatch.
- **PROD.** The PROD client may not have the same scopes as TEST (for example Channel Lookup), so a tool that works on TEST can be refused or unavailable on PROD.

## 7. Known rough edges

- `whoami` does not list agreement labels; ask the operator, or look at `STRALFORS_PROFILE_<ID>_ACTION_IDS` if you run the server yourself.
- A new assistant session does not remember the profile id or labels; repeat them or ask it to call `whoami` first.
- Candidate matching for `channel_lookup` has not been checked against a real registered recipient (see above).

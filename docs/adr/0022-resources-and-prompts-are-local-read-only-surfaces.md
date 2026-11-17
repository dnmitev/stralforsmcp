---
status: accepted
---
# Resources and prompts are local, read-only surfaces

04-01 added `search_docs`. Clients also offer resources (attach a document to a conversation) and prompts (guided starts). Both fit the knowledge docs, and both must keep working when the vendor API is down.

## Decision

1. **Resources are the knowledge docs, nothing else.** A static `knowledge://index` (id, title, source, country, channel, no bodies) and a template `knowledge://docs/{id}` whose list callback enumerates every doc. A read returns `text/markdown`: a header with title, source label, country, channel and link, then the body. Docs come from the index loaded once at start; a read does no I/O and needs no Stralfors client. Live data (rules, channels) stays in tools.
2. **Same visibility as `search_docs`.** Any authenticated principal sees every doc, public and private, in every environment (ADR 0021). Resources and prompts are registered only when a principal exists. They are not tools, so the policy decision (`decide`) does not apply.
3. **Audit.** One line per resource read (`tool: resource:read`) and per prompt get (`tool: prompt:get`), outcome `allowed`; a failed read is `error` / `bad_input`, a rejected prompt argument is `error` / `invalid_input`. Ids, URIs and argument values never reach the audit.
4. **Not-found is `InvalidParams` (-32602) with fixed text.** The installed SDK maps a missing resource to that code and its own not-found error carries the requested URI in its data. The handler throws a protocol error with a fixed message, identical for an unknown and an invalid id, and echoes nothing. A URI that matches no resource or template at all (for example an extra path segment) gets the SDK's default not-found error, which does echo the URI; that case is accepted, since the caller supplied the URI.
5. **Prompts are fixed text.** `explain_channel`, `prepare_validation` and `explain_validation_findings` are constants plus validated arguments (channel `^[A-Za-z0-9]{1,40}$`, country two capitals, findings up to 4000 characters). They tell the assistant which tools to call and to report an unavailable tool instead of guessing. Pasted findings sit in a fenced block labelled as data, not instructions. A prompt never calls Stralfors. Arguments rejected by the schema are audited through the same wrapper tools use.
6. **Capabilities advertise `listChanged: false`.** The docs are fixed for the process lifetime; the SDK default of `true` would promise notifications we never send.
7. **Prompts are not file-defined yet.** Letting an operator add prompts through the overlay needs a format, limits and a leak review; it waits for a concrete need.
8. **A doc without `country` or `channel` is general.** The `search_docs` filters match such a doc for any value, so a country-neutral overview is not hidden by a country filter.
9. **Start-up may name skipped public docs.** The loader tags every warning with its source; the log carries the base names of skipped public docs and only a count for private ones. This amends ADR 0021 item 6.

## Consequences

- A client can attach a whole doc, and a PM gets a guided start without learning tool names.
- A prompt can name a tool the caller cannot see (for example validation in PROD); the text says to report it as unavailable.
- Adding a doc is still a file change and a restart; clients see the new list after reconnecting.

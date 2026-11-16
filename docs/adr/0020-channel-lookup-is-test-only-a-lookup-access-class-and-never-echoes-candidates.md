---
status: accepted
---
# channel_lookup is TEST only, has its own access class and never echoes candidates

`channel_lookup` asks the vendor's Channel Lookup API which delivery channels can reach a recipient. The API is asynchronous: a POST starts a lookup and returns a correlation id, a GET returns the completed result. The candidates are personal identifiers, and the answer lists matched candidates only.

## Decision

1. **A new access class, `lookup`.** It is allowed in TEST for every role that has TEST, denied in PROD with reason `lookup`, and needs neither the write flag nor a scope claim. `read` would list the tool in PROD where its POST is always refused. `write` would need write claims, which are not wired in this phase, and it creates no document.
2. **The write guard opens exactly one POST.** In TEST, `POST` on the exact lookup path without a query is allowed whatever the write flag says. Every other POST still needs the write flag, and PROD allows no POST at all. The rule is on the parsed path, like the others.
3. **Candidates never leave the call.** They travel only in the request body. They are not logged, audited, put in spans or metrics, echoed in errors or returned. The correlation id and the customer identifier of the answer are dropped too.
4. **The answer is mapped, not passed through.** The vendor lists matches only, so `available[i]` is true when candidate `i` appears among the matches after both sides are normalised (letters and digits, lower-case). `unrecognised` counts matches that fit no candidate, so a spelling mismatch is visible without showing a value. A channel with an error text, or missing from the answer, is `failed` with a fixed `reason`: `not_configured` when the vendor sentence says the channel's configuration is missing for this client (a state the maintainer meets on TEST), `error` otherwise. The vendor text is never returned.
5. **Polling is bounded and never re-posts.** One POST, then a GET each second for at most 20 seconds. A JSON 404 means not completed (or unknown) and keeps polling; any other error ends the call; the bound gives a fixed text without the id.

## Consequences

- PROD gains no new reachable path. If the vendor grants Channel Lookup scopes in PROD, the decision to open a PROD lookup is separate and revisits item 2.
- The guard now has one method-and-path exception in TEST; a future allowlist-style guard should list it, not widen it.
- The mapping depends on the vendor spelling matches in a way that survives normalisation. `unrecognised` is the signal when it does not.

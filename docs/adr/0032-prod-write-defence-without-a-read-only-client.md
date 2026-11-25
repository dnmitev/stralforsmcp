---
status: accepted
---
# PROD write defence without a read-only client from the API vendor

The write defence for `prod` was designed in six layers:
1. the API vendor issues a read-only client;
2. write tools are not registered;
3. the write guard;
4. the start-up refusal of `prod` with writes enabled;
5. alerting;
6. a test per layer.

A read-only client was asked for and never provided, and the PROD tokens observed carry the write scope. The question was whether `prod` could be used anyway.

## Decision

1. **Layers 2 to 6 are accepted in place of layer 1, in writing, by the maintainer.** Each of them is tested, and each was checked against a running server in `prod` mode: only the read tools are listed, other roles see none, and the blocked-write counter reads 0.
2. **A blocked write pages someone.** The guard's refusals are counted, the count starts at zero, and a critical alert fires on the first one, including a block that happens before the first scrape. The alert is tested with Prometheus's rule engine, not only as text.
3. **The dry run stays off in `prod` by default.** Turning it on needs the vendor to confirm that a dry run creates nothing and reserves no consignment id. Until then the guard proves the shape of a request, not the absence of side effects at the API.
4. **The decision is revisited** when:
   - the vendor answers;
   - the `prod` dry run is enabled;
   - the PROD credentials are renewed or rotated;
   - the blocked-write alert fires in `prod`.

## Consequences

- A PROD credential that leaks outside this server can write. Its protection is the operator's secret handling, not this code.

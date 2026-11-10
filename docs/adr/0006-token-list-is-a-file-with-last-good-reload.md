---
status: accepted
---
# The token list is a file re-read on an interval, and a bad file never replaces the last good one

User identities and access-token digests live in one mounted JSON file, not in a database or an identity provider. The server parses the file at start-up and refuses to start if it is invalid; afterwards it re-reads the file on a timer and, when the new content fails to parse or cross-check, keeps serving the previous valid view and logs the failure once per distinct cause. A database would add an operational dependency for a handful of users, and swapping the file for a live endpoint later only changes the reader. The price is that revocation and expiry take effect only on the next successful reload, so the interval is the revocation latency.

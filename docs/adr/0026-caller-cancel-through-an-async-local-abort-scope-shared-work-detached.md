---
status: accepted
---
# Caller cancel travels through an async-local abort scope; shared work runs detached

A cancelled MCP request, or one whose connection dropped, used to leave its Stralfors request running until the upstream timeout. The SDK already aborts the request's signal on cancel and on connection close, so the server only has to carry that signal to the client. We carry it in an async-local scope opened by the registry around each tool call (`withSignal`), the same way the principal context travels, instead of adding a signal parameter to every client method and tool.

## Decision

1. **The client reads the signal from the scope.** Before taking a cap slot it fails a request whose signal has already aborted, and it passes the signal to the socket, so a cancel aborts the request in flight. The error is `CancelledError` (kind and audit reason `cancelled`); the request is never replayed.
2. **Shared work never sees a caller's signal.** A token refresh and a rules cache fill are awaited by several callers at once. The token source takes no signal (only the socket of the vendor request does), and a rules cache fill runs detached from every caller's scope (`detached`). Each caller waits with its own abort (`untilAborted`), so one caller's cancel ends only its own wait and the shared work completes for the others. Cancelling a caller waiting for a token refresh frees that caller's cap slot. A shared rules cache fill keeps its own slot until it finishes; callers waiting for the fill hold no separate slots.
3. **The channel lookup's budget is a second signal in the same scope.** Its 20 s budget is combined with the caller's signal and aborts whatever request is in flight when it runs out; a timeout and a caller cancel are reported differently.
4. **A cancelled create has an unknown outcome.** Aborting a write closes the socket, but the vendor may already have accepted the document. The audit records `cancelled`, not a failure, and a tool that sends must tell the caller to check the document's status before trying again.

## Considered options

- Threading an `AbortSignal` argument through every client method: explicit, but touches every operation and tool signature for one cross-cutting concern, and code that forgets to pass it fails silently in the same way a scope would.

## Consequences

Any new shared or cached upstream work must be started detached, or the first caller's cancel will fail every other caller waiting on it. Tests pin this for the rules cache fill and for a cancel during a token refresh.

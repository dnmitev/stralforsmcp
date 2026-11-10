---
status: accepted
---
# A connection reset counts as a TLS failure until the agent has had one response

With TLS 1.3 the server rejects a client certificate after the handshake has completed on the client side, so the rejection arrives as a socket reset, not as a TLS error code. We classify resets and socket-closed errors as `TlsError` only while a connection agent has never received an HTTP response, and as `UpstreamError` afterwards, when the same codes almost always mean a keep-alive race. A reset on a genuine first request that is not a certificate problem is knowingly misreported; we accepted that over the alternatives of calling every reset a certificate failure or hiding real certificate problems behind a generic network error.

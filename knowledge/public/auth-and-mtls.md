---
id: auth-and-mtls
title: Authentication and mutual TLS basics
tags: authentication, mtls, certificate, token, security
link: https://developer.stralfors.com/docs
---
The vendor API uses two layers. The transport requires mutual TLS: the client presents a certificate that the vendor has registered, and the connection is refused without it. On top of that, the client obtains an access token with its client identifier and secret and sends it as a bearer token.

A connection reset during the handshake usually means the certificate is missing, expired or not registered for that environment, not a network outage. Test and production use separate registrations.

Keep the certificate, key, client identifier and secret out of source control and logs. Tokens are short lived; request a new one rather than storing it.

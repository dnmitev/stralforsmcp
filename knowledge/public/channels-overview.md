---
id: channels-overview
title: Delivery channels overview
tags: channels, delivery, overview
link: https://developer.stralfors.com/docs
---
A delivery channel is a route by which an invoice reaches its recipient, for example print, post, e-invoice or a digital mailbox. Which channels exist depends on the environment and on the agreement the client has with the vendor.

The channels endpoint lists the channels available to the calling client in one environment. Use it first when a document is refused for its channel: a channel that is missing from the list is not set up for that client in that environment, and only the vendor can enable it.

Channel names are short alphanumeric identifiers. They are case sensitive in requests, so copy them exactly as the list returns them.

This is a short summary written for orientation. The vendor documentation is the authority.

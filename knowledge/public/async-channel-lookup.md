---
id: async-channel-lookup
title: Channel lookup is asynchronous
tags: lookup, kivra, digital mailbox, asynchronous
link: https://test.developer.stralfors.com/docs
---
Channel lookup asks which digital channels, such as a digital mailbox, can reach a recipient. It works in two steps: a request starts the lookup and returns a correlation identifier, and a later request fetches the completed answer.

Until the lookup completes, fetching the answer reports that nothing is ready, which is not a failure. Poll at a gentle interval, such as once a second, and stop after a bounded time instead of starting a second lookup.

The answer lists matches only. A candidate that is absent from the matches is not reachable through that channel. A channel can also report that it is not configured for the client; that is a vendor-side setup matter.

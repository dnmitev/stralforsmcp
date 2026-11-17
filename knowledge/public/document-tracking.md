---
id: document-tracking
title: Tracking a document
tags: tracking, status, delivery, document
link: https://developer.stralfors.com/docs
---
Tracking returns the delivery status of a document already submitted. A document can be found by its invoice number, an external document identifier or the vendor document identifier.

Status is reported per document and per channel. It lags real delivery by hours or days, so a single call is a snapshot, not a live stream. Statuses such as in progress, delivered, refused and failed describe the channel outcome at the time of the call.

Tracking results can contain recipient details. Pass on the outcome, not the personal data.

---
id: rules-endpoint
title: The rules endpoint and invoice rules
tags: rules, validation, schema, invoice
link: https://developer.stralfors.com/docs
---
The rules endpoint returns the field rules for a document type in a country: which fields are required, their types and their length limits. Rules differ by country and can change between environments, so fetch them for the environment you are targeting.

Rules describe shape, not business outcome. A document that satisfies every rule can still be refused by the dry run, for example because of an agreement setting. Treat the rules as a fast local pre-check and the dry run as the authority.

Rules are stable for hours, so a client may cache them for a while. Re-fetch after a vendor release announcement or when a previously valid document starts failing.

---
id: validate-dry-run
title: Validate with the dry run
tags: validate, dry run, invoice, findings
link: https://developer.stralfors.com/docs
---
The vendor offers a dry run for invoices: the document is checked exactly as a real submission would be, but nothing is created or delivered. It is the only authoritative answer to whether a document would be accepted.

The dry run often reports faults in rounds. Header-level faults come first; once they are fixed, faults in the template part may appear. A clean first answer therefore does not always mean the document is valid, and a fix-and-retry loop is normal.

Use synthetic data only when trying documents against a shared environment. A dry run still sends the content to the vendor.

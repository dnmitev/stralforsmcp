---
status: accepted
---
# Audit events carry fixed codes only; the event type has no field for arguments, payloads or document identifiers

An audit event is one line with timestamp, user id, role, tool name, environment, outcome, an optional reason code, duration and the optional API trace id. There is no field for tool arguments, request or response bodies, agreement ids or consignment ids, so a tool handler cannot attach them without changing the event type. What is guaranteed is exactly that: the shape of the event is closed and every value in it is either a fixed code, a number, a timestamp or an id the server itself assigned or received for support purposes. What is not guaranteed by the type alone is the content of the free-form strings (`reason` accepts any error kind string, `tool` is the tool name, `traceId` is whatever the API returned); keeping those free of payload data is a convention enforced by review and tests, not by the compiler. The alternative, a richer event with redacted arguments, was rejected because redaction has to be right every time while an absent field cannot leak.

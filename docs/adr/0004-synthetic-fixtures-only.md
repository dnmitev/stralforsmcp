---
status: accepted
---
# Test fixtures are synthetic, never copies of vendor or customer payloads

Live API responses carry contact details, identifiers and vendor-licensed text, and anything committed to this public repository stays in its history. We decided that fixtures are written by hand in the observed shape with placeholder values and nil ids, that secrets and certificates used in tests are generated at runtime, and that no live body is committed even in sanitised form. Lower fidelity is accepted; the live smoke script exists to check the real shapes on demand.

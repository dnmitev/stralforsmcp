#!/bin/sh
# Reads stdin; exits 1 if any line matches the private denylist. Never prints patterns or matches.
set -eu
DL=${STRALFORSMCP_DENYLIST:-$HOME/.config/stralforsmcp/denylist}
if [ ! -f "$DL" ]; then echo 'denylist: not found, skipped' >&2; exit 0; fi
P=$(mktemp)
trap 'rm -f "$P"' EXIT INT TERM
grep -vE '^[[:space:]]*(#|$)' "$DL" > "$P" || true
[ -s "$P" ] || exit 0
N=$(grep -ciE -f "$P" || true)
if [ "$N" -gt 0 ]; then echo "denylist: $N match(es)" >&2; exit 1; fi

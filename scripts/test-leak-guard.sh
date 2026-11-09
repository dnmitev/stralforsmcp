#!/bin/sh
# Canary tests for the leak guard (hooks + gitleaks + denylist). Secrets are built at runtime.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
FAILS=0

rnd() { LC_ALL=C tr -dc "$1" </dev/urandom | head -c "$2"; }

CANARY=canary-zz-term
printf '%s\n' '# test denylist' "$CANARY" > "$TMP/denylist"
MISSING="$TMP/no-such-denylist"

# run_case NAME EXPECT(reject|accept) SECRET FILE_CONTENT MESSAGE DENYLIST
# SECRET: text that must not appear in output (case-insensitive), may be empty
run_case() {
  name=$1 expect=$2 secret=$3 content=$4 msg=$5 dl=$6
  d="$TMP/$name"; mkdir -p "$d"
  (
    cd "$d"
    git init -q .
    git config user.name tester
    git config user.email tester@example.invalid
    git config commit.gpgsign false
    cp -R "$ROOT/.githooks" . 2>/dev/null || true
    cp "$ROOT/.gitleaks.toml" . 2>/dev/null || true
    cp -R "$ROOT/scripts" . 2>/dev/null || true
    sh scripts/setup-hooks.sh >/dev/null 2>&1 || true
    printf '%s\n' "$content" > file.txt
    git add file.txt
    if STRALFORSMCP_DENYLIST="$dl" git commit -q -m "$msg" >"$d.out" 2>&1; then echo accept >"$d.rc"; else echo reject >"$d.rc"; fi
  )
  got=$(cat "$d.rc"); ok=1
  if [ "$got" != "$expect" ]; then echo "FAIL $name: expected $expect, got $got"; ok=0; fi
  if [ "$expect" = reject ] && [ -n "$secret" ] && grep -qiF -- "$secret" "$d.out"; then
    echo "FAIL $name: output leaks secret"; ok=0
  fi
  if [ "$name" = no-denylist ] && ! grep -qF 'denylist: not found, skipped' "$d.out"; then
    echo "FAIL $name: warning line missing"; ok=0
  fi
  if [ $ok = 1 ]; then echo "PASS $name"; else FAILS=$((FAILS+1)); fi
}

# secret-key: fake private key block
B1=$(rnd 'A-Za-z0-9' 64); B2=$(rnd 'A-Za-z0-9' 64); B3=$(rnd 'A-Za-z0-9' 64)
KEY="-----BEGIN PRIV""ATE KEY-----
$B1
$B2
$B3
-----END PRIV""ATE KEY-----"
run_case secret-key reject "$B1" "$KEY" "add key" "$MISSING"

# aws: AKIA + 16 uppercase base32 chars
AWS="AK""IA$(rnd 'A-Z2-7' 16)"
run_case aws reject "$AWS" "aws_access_key_id = $AWS" "add aws" "$MISSING"

# smcp: smcp_ + 40 alnum
SM="smcp""_$(rnd 'A-Za-z0-9' 40)"
run_case smcp reject "$SM" "token = $SM" "add token" "$MISSING"

# denylist in staged content (different case than the term)
run_case denylist-content reject "$CANARY" "Hello CANARY-ZZ-TERM" "add hello" "$TMP/denylist"

# denylist in commit message
run_case denylist-message reject "$CANARY" "Hello world" "mention $CANARY here" "$TMP/denylist"

# clean
run_case clean accept "" "Hello world" "add hello" "$TMP/denylist"

# no denylist file: warn and allow
run_case no-denylist accept "" "Hello world" "add hello" "$MISSING"

[ "$FAILS" -eq 0 ]

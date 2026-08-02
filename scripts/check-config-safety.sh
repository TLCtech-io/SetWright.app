#!/usr/bin/env bash
# Config-safety guard.
#
# supabase/config.toml's [auth.rate_limit] block is relaxed ~33x for the local integration suite. A
# `supabase config push` (or `db push`) would carry those relaxed limits to the hosted project,
# permitting credential stuffing / OTP brute force. A HUMAN manually running that command is a footgun
# CI cannot intercept, but CI can (1) block any AUTOMATED push in the repo and (2) keep the LOCAL-ONLY
# warning from being silently dropped while the relaxed values remain. This is the durable half of the
# mitigation; the other half is verifying the hosted dashboard limits (a manual, out-of-band step).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
fail=0

# 1. No workflow or repo script may push the local config to a hosted project. (This script is
#    excluded so its own grep pattern does not self-match.)
if grep -rniE 'supabase +(config|db) +push' .github/ scripts/ --exclude=check-config-safety.sh 2>/dev/null; then
  echo "ERROR: the line(s) above invoke 'supabase config/db push' in automation — that would ship" >&2
  echo "       the relaxed [auth.rate_limit] block in supabase/config.toml to production. Remove it," >&2
  echo "       or reset the auth limits before any deliberate, manual push." >&2
  fail=1
fi

# 2. Warning integrity: if the relaxed auth limits are present, the LOCAL-ONLY marker must be too, so
#    the footgun can never be silently un-documented.
if grep -qE '^[[:space:]]*sign_in_sign_ups[[:space:]]*=[[:space:]]*1000' supabase/config.toml; then
  if ! grep -q 'config-safety-guard' supabase/config.toml; then
    echo "ERROR: supabase/config.toml has relaxed auth limits (sign_in_sign_ups = 1000) but its" >&2
    echo "       'config-safety-guard' LOCAL-ONLY marker is gone. Restore the warning above the" >&2
    echo "       [auth.rate_limit] block so the do-not-push note stays attached to the values." >&2
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "config-safety-guard: FAILED" >&2
  exit 1
fi
echo "config-safety-guard: OK (no automated config/db push; local-only auth limits are marked)."

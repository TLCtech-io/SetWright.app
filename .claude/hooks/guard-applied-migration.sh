#!/usr/bin/env bash
# PreToolUse guard: protect the locked base contract.
#
# Migrations ...0001 (schema) ... ...0005 (original hydration/perform) are the
# base contract that core/src/types.ts mirrors. The schema is the contract:
# change it with a NEW migration, never by editing an applied base file. This
# blocks Edit/Write against those files and tells Claude to add a migration
# instead.
#
# To change scope, edit the case pattern below. To broaden to every applied
# migration, use: *supabase/migrations/*.sql)
#

set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

case "$file" in
*supabase/migrations/2025010100000[1-5]_*.sql)
{
    echo "Blocked: $file is a locked base migration (schema / rls / hydration)."
    echo "The schema is the contract. Do not edit an applied base migration."
    echo "Add a NEW migration in supabase/migrations/ and update core/src/types.ts in the same change."
} >&2
exit 2
;;
esac

exit 0

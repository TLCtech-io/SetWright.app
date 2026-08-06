#!/usr/bin/env bash
# PreToolUse guard: protect the locked base contract.
#
# Migrations ...0001 through ...0008 are the whole baseline: schema, rls, guards,
# hydration, and the three RPC files, plus the catalog comments. Together they are
# the contract that core/src/types.ts mirrors. Every one of them is applied, so the
# rule is the same for all eight: change the schema with a NEW migration at 009 or
# above, never by editing a baseline file. This blocks Edit/Write against them and
# tells Claude to add a migration instead.
#
# The previous pattern stopped at ...0005 because the baseline was five files inside
# a 64-file set. It is now eight files and nothing else, so the lock covers all of it.
#
# _archive/ holds the 64 migrations this baseline replaced. It is historical and never
# applied, but it is also the only record of why the schema is shaped the way it is, so
# it is locked too.
#
# To change scope, edit the case patterns below.
#
# Deliberate override: create .claude/.allow-baseline-edit and the guard stands down until
# it is removed. It is a file rather than an environment variable on purpose. Hooks run as
# subprocesses of the agent and inherit its environment, so a variable exported in a shell
# never reaches here, while a file on disk always does. The override is visible in
# `git status`, survives nothing, and has to be deleted by hand, which is the point.
#
# While the marker exists the guard is off for every file it would otherwise protect,
# baseline and archive alike. It cannot tell a comment edit from a schema change.
#

set -uo pipefail

if [ -f "${CLAUDE_PROJECT_DIR:-.}/.claude/.allow-baseline-edit" ]; then
    echo "guard-applied-migration: standing down, .claude/.allow-baseline-edit is present." >&2
    exit 0
fi

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

case "$file" in
*supabase/migrations/_archive/*.sql)
{
    echo "Blocked: $file is an archived migration."
    echo "The archive is the historical record of why the schema is shaped the way it is."
    echo "It is never applied and never edited. If a statement in it is wrong, correct it in the"
    echo "baseline or in the decision record, not here."
} >&2
exit 2
;;
*supabase/migrations/2025010100000[1-8]_*.sql)
{
    echo "Blocked: $file is part of the locked baseline (001 schema, 002 rls, 003 guards,"
    echo "004 hydration, 005-007 rpcs, 008 comments)."
    echo "The schema is the contract. Do not edit an applied baseline migration."
    echo "Add a NEW migration at 20250101000009 or above and update core/src/types.ts in the same change."
} >&2
exit 2
;;
esac

exit 0

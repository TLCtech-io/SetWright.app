#!/usr/bin/env bash
# PostToolUse: keep the core suite green.
#
# core is the fast feedback loop the rest of the repo builds on. When an edit
# touches packages/core, run its tsx unit suite. On failure, feed the output
# back to Claude (exit 2) so it fixes the break in the same turn. Non-core
# edits are ignored.
#

set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

case "$file" in
*packages/core/*) ;;
*) exit 0 ;;
esac

cd "$CLAUDE_PROJECT_DIR" || exit 0

if ! out=$(npm test -w @repertoire/core 2>&1); then
{
    echo "core suite failed after editing $file:"
    printf '%s\n' "$out"
} >&2
exit 2
fi

exit 0

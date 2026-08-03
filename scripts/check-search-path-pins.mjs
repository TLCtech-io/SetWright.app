// Fail the build when a function ends up with no pinned search_path.
//
// An unpinned search_path lets whatever a session set decide which table an unqualified name
// resolves to. The convention here is that every function carries `set search_path`, and 58 of
// them do it in the declaration itself.
//
// The reason this needs a check rather than a code review habit: CREATE OR REPLACE FUNCTION
// RESETS a function's configuration. Migration 059 pins hydrate_draft_input and
// hydrate_setlist_locks with ALTER FUNCTION rather than redeclaring them, because their bodies are
// long. hydrate_draft_input has already been redeclared five times (003, 031, 032, 033, 034), so
// the next migration that redeclares it silently drops the pin, and nothing in the schema records
// that anything was lost.
//
// So this walks the migrations in order and models the FINAL state of each function, the same way
// Postgres does: a declaration sets the pin to whatever its own header says, a later
// ALTER ... SET search_path turns it on, and a DROP removes the function from consideration.
//
// Run: node scripts/check-search-path-pins.mjs

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "supabase", "migrations");

// `create [or replace] function [schema.]name(`
const DECL = /create\s+(?:or\s+replace\s+)?function\s+(?:[a-z_]+\.)?([a-z_]+)\s*\(/gi;
// `alter function [schema.]name(...) ... set search_path`
const ALTER = /alter\s+function\s+(?:[a-z_]+\.)?([a-z_]+)\s*\([^)]*\)\s*set\s+search_path/gi;
// `drop function [if exists] [schema.]name`
const DROP = /drop\s+function\s+(?:if\s+exists\s+)?(?:[a-z_]+\.)?([a-z_]+)/gi;

/** name -> { pinned, file } for every function currently in force. */
const live = new Map();

const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");

    for (const m of sql.matchAll(DROP)) live.delete(m[1].toLowerCase());

    for (const m of sql.matchAll(DECL)) {
        const name = m[1].toLowerCase();
        // The header runs from the declaration to the start of the body. `set search_path` is only
        // a pin when it sits there; the same words inside a body are just SQL text.
        const bodyAt = sql.indexOf("as $", m.index);
        const header = sql.slice(m.index, bodyAt === -1 ? sql.length : bodyAt);
        live.set(name, { pinned: /set\s+search_path/i.test(header), file });
    }

    // ALTER runs after the declarations in the same file, which matches how these migrations are
    // written: pin an existing function rather than redeclare it.
    for (const m of sql.matchAll(ALTER)) {
        const name = m[1].toLowerCase();
        const entry = live.get(name);
        if (entry) live.set(name, { pinned: true, file });
    }
}

const unpinned = [...live.entries()]
    .filter(([, v]) => !v.pinned)
    .sort(([a], [b]) => a.localeCompare(b));

if (unpinned.length > 0) {
    for (const [name, v] of unpinned) {
        console.error(
            `FAIL  ${name}() has no pinned search_path. Its last declaration is in ${v.file}.`,
        );
    }
    console.error(
        `\n${unpinned.length} function(s) end up unpinned. Add \`set search_path = pg_catalog, pg_temp\`\n` +
            "to the declaration (add `public` too if the body references tables unqualified), or pin it\n" +
            "with ALTER FUNCTION in the same migration. Remember CREATE OR REPLACE clears an earlier pin.",
    );
    process.exit(1);
}

console.log(
    `search-path-pins: OK (${live.size} functions in force, all pinned across ${files.length} migrations)`,
);

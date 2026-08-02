// Parse-validate the SQL with libpg_query, the real PostgreSQL parser. No
// database needed. This catches grammar errors, not semantic ones (a wrong
// column name parses fine). Run with: npm test
//
// The canonical SQL now lives as Supabase migrations at the repo root
// (supabase/migrations); this validates every migration in apply (lexicographic)
// order. Live validation - applying the migrations + calling the functions against
// the auth schema - is `supabase db reset` against the local stack.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// No type declarations ship with the parser, so it comes in as any. The CJS
// module exposes the emscripten factory as its default export.
const PgQuery = require("pg-query-emscripten").default;

const here = dirname(fileURLToPath(import.meta.url));
// packages/db/test -> repo root -> supabase/migrations
const migrationsDir = join(here, "..", "..", "..", "supabase", "migrations");
const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

let failed = 0;
for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    // A fresh parser per file: the emscripten WASM heap is not reset between parses and
    // degrades after enough input, crashing on a later file that parses fine on its own.
    const pg = await new PgQuery();
    const result = pg.parse(sql);
    if (result.error) {
        failed += 1;
        const { message, cursorpos } = result.error;
        console.error(`FAIL  ${file}: ${message} (at character ${cursorpos})`);
        continue;
    }
    const stmts = result.parse_tree?.stmts?.length ?? "parsed";
    console.log(`ok    ${file} (${stmts} statements)`);
}

if (failed > 0) {
    console.error(`\n${failed} file(s) failed to parse`);
    process.exit(1);
}
console.log("\nall SQL parses as valid PostgreSQL");

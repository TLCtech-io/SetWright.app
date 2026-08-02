// Fail the build when a test file exists but never runs.
//
// Every workspace's `test` script is a hand-written chain of tsx calls, not a glob. A new
// file under the workspace's test directory runs nowhere until someone remembers to append
// it, and a green `npm run verify` then reports coverage that was never executed. That is
// how apps/web/test/unit/publishedRefresh.mock.test.ts sat unrun.
//
// Checks both directions: every *.test.ts on disk appears in the script, and every path the
// script names still exists. Run: node scripts/check-test-registration.mjs

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// [workspace, the directory holding its *.test.ts files, relative to the workspace]
// packages/db's suite leads with test/validate.ts, which is not a *.test.ts file and so is not
// scanned; the *.test.ts files that sit alongside it are.
const WORKSPACES = [
    ["packages/core", "test"],
    ["packages/api", "test"],
    ["packages/db", "test"],
    ["apps/web", "test/unit"],
];

let failures = 0;

for (const [workspace, testDir] of WORKSPACES) {
    const pkgPath = join(root, workspace, "package.json");
    const dirPath = join(root, workspace, testDir);
    if (!existsSync(pkgPath) || !existsSync(dirPath)) {
        console.error(
            `FAIL  ${workspace}: expected ${pkgPath} and ${dirPath} to exist`,
        );
        failures += 1;
        continue;
    }

    const script =
        JSON.parse(readFileSync(pkgPath, "utf8")).scripts?.test ?? "";
    const onDisk = readdirSync(dirPath)
        .filter((f) => f.endsWith(".test.ts"))
        .sort();

    const unregistered = onDisk.filter(
        (f) => !script.includes(`${testDir}/${f}`),
    );
    for (const f of unregistered) {
        console.error(
            `FAIL  ${workspace}/${testDir}/${f} exists but is not in ${workspace}'s "test" script, so it never runs.`,
        );
        failures += 1;
    }

    // The reverse: a script entry whose file was renamed or deleted.
    const referenced = [
        ...script.matchAll(/(?:^|\s)(\S*?[\w./-]+\.test\.ts)/g),
    ].map((m) => m[1]);
    for (const ref of referenced) {
        if (!existsSync(join(root, workspace, ref))) {
            console.error(
                `FAIL  ${workspace}'s "test" script runs ${ref}, which does not exist.`,
            );
            failures += 1;
        }
    }

    if (!unregistered.length) {
        console.log(
            `ok    ${workspace} (${onDisk.length} test files, all registered)`,
        );
    }
}

if (failures > 0) {
    console.error(
        `\n${failures} problem(s). Append missing files to the workspace "test" script, or remove stale entries.`,
    );
    process.exit(1);
}

console.log("\nevery test file is registered and every registered file exists");

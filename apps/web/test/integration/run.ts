// Integration runner for the Supabase adapter. Requires the local stack up
// (`npx supabase start`) and Docker. Each domain resets the data (truncate + reload
// the seed over the live connection) for isolation, then runs as a seeded user
// against createSupabaseRepository.
//
//   npm run test:integration   (from apps/web)

import { resetDb, waitForAuth } from "./helpers";
import { run as songs } from "./songs.itest";
import { run as vocab } from "./vocab.itest";
import { run as events } from "./events.itest";
import { run as setlists } from "./setlists.itest";
import { run as playgrounds } from "./playgrounds.itest";
import { run as isolation } from "./isolation.itest";
import { run as casting } from "./casting.itest";
import { run as ensembles } from "./ensembles.itest";
import { run as invite } from "./invite.itest";
import { run as member } from "./member.itest";
import { run as access } from "./access.itest";
import { run as publicid } from "./publicid.itest";
import { run as adminrate } from "./adminrate.itest";
import { run as directorinvite } from "./directorinvite.itest";

const domains: Array<[string, () => Promise<void>]> = [
    ["songs", songs],
    ["vocab", vocab],
    ["events", events],
    ["setlists", setlists],
    ["playgrounds", playgrounds],
    ["isolation", isolation],
    ["casting", casting],
    ["ensembles", ensembles],
    ["invite", invite],
    ["member", member],
    ["access", access],
    ["publicid", publicid],
    ["adminrate", adminrate],
    ["directorinvite", directorinvite],
];

async function main(): Promise<void> {
    let failed = 0;
    for (const [name, run] of domains) {
        console.log(`\n# ${name}`);
        try {
            resetDb();
            await waitForAuth();
            await run();
            console.log(`  PASS ${name}`);
        } catch (e) {
            failed += 1;
            console.error(`  FAIL ${name}: ${(e as Error).message}`);
        }
    }
    if (failed > 0) {
        console.error(`\n${failed} domain(s) failed`);
        process.exit(1);
    }
    console.log("\nall integration domains passed");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

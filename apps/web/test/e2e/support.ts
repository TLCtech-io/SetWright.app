// Shared helpers for the supabase-mode e2e specs: the running stack's URL + keys (parsed from
// `supabase status`, like playwright.config), and a Mailpit reader that pulls the one-time token_hash out
// of an invite email so a test can accept the invite on the test server. Not a *.spec.ts file, so
// Playwright never runs it as a test.

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
);
const env = execSync("npx supabase status -o env", {
    cwd: repoRoot,
    encoding: "utf8",
});

export const API_URL = /API_URL="?([^"\n]+)/.exec(env)?.[1] ?? "";
export const ANON = /ANON_KEY="?([^"\n]+)/.exec(env)?.[1] ?? "";
export const SERVICE = /SERVICE_ROLE_KEY="?([^"\n]+)/.exec(env)?.[1] ?? "";

const MAILPIT = "http://127.0.0.1:54324";

// How many messages Mailpit currently holds for `email`. Used to assert a send happened by delta (the
// stack accumulates mail, so an absolute count is unreliable; before-vs-after is).
export async function mailpitCountTo(email: string): Promise<number> {
    const res = await fetch(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent("to:" + email)}`,
    )
        .then((r) => r.json())
        .catch(() => null);
    return (
        (res?.messages_count as number | undefined) ??
        (res?.total as number | undefined) ??
        0
    );
}

// Poll Mailpit for the invite email to `email` and pull the one-time token_hash out of its /auth/confirm
// link (invite.html links to {SiteURL}/auth/confirm?token_hash=<hex>&type=invite). Returns the hash only,
// so the test verifies it on the test server rather than the SiteURL port baked into the email.
export async function inviteTokenHash(email: string): Promise<string> {
    for (let i = 0; i < 30; i += 1) {
        const list = await fetch(
            `${MAILPIT}/api/v1/search?query=${encodeURIComponent("to:" + email)}`,
        )
            .then((r) => r.json())
            .catch(() => null);
        const id = list?.messages?.[0]?.ID as string | undefined;
        if (id) {
            const msg = await fetch(`${MAILPIT}/api/v1/message/${id}`).then(
                (r) => r.json(),
            );
            const body = `${msg.HTML ?? ""} ${msg.Text ?? ""}`;
            const m = /token_hash=([a-f0-9]+)/i.exec(body);
            if (m) return m[1]!;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`no invite email with a token_hash arrived for ${email}`);
}

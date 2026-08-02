// Fail the build when the auth email surfaces drift apart.
//
// The copy for every auth email lives in supabase/functions/_shared/email/. Three other places
// have to stay in step with it, and none of them is checked by a typechecker:
//
//   supabase/templates/*.html   generated output, easy to hand-edit by mistake
//   supabase/config.toml        the subject lines and the content_path wiring
//   the hosted dashboard        pasted by hand, and outside this repo entirely
//
// This checks the first two, and pins the link shape everything depends on. The dashboard is
// yours to keep in step; the failure messages here name what to paste.
//
// Run: npm run email:check  (also runs inside npm run verify)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    EMAIL_KINDS,
    GO_TEMPLATES,
    renderGoTemplate,
} from "../supabase/functions/_shared/email/authEmail.ts";
import { copyFor } from "../supabase/functions/_shared/email/copy.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = join(root, "supabase", "templates");
const configPath = join(root, "supabase", "config.toml");
const moduleDir = join(root, "supabase", "functions", "_shared", "email");

let failures = 0;
function fail(message: string): void {
    console.error(`FAIL  ${message}`);
    failures += 1;
}

// 1. Drift. The committed HTML must be exactly what the module renders today.
for (const t of GO_TEMPLATES) {
    const path = join(templateDir, t.file);
    if (!existsSync(path)) {
        fail(
            `supabase/templates/${t.file} is missing. Run "npm run email:build".`,
        );
        continue;
    }
    const onDisk = readFileSync(path, "utf8");
    const fresh = renderGoTemplate(t.kind).html;
    if (onDisk !== fresh) {
        // Name the likeliest cause first. .vscode/settings.json sets Prettier as the default
        // formatter, so a format-on-save reindents these generated files and the drift looks like
        // a copy change when nothing in the module moved. .prettierignore covers it; a diff that
        // is pure whitespace and self-closing slashes means that file is not being honoured.
        const whitespaceOnly =
            onDisk.replace(/\s+/g, "") === fresh.replace(/\s+/g, "");
        fail(
            whitespaceOnly
                ? `supabase/templates/${t.file} differs from the module in whitespace only, so a formatter reindented it rather than anyone changing the copy. Check that .prettierignore still lists supabase/templates/, then run "npm run email:build" to restore it.`
                : `supabase/templates/${t.file} does not match the module. Edit the copy in supabase/functions/_shared/email/, then run "npm run email:build". Never edit the generated HTML directly.`,
        );
    }
}

// 2. Orphans. A template nothing wires is a template nobody updates.
const known = new Set(GO_TEMPLATES.map((t) => t.file));
for (const file of readdirSync(templateDir).filter((f) =>
    f.endsWith(".html"),
)) {
    if (!known.has(file)) {
        fail(
            `supabase/templates/${file} is not in GO_TEMPLATES, so nothing generates or wires it. Add it to the manifest or delete it.`,
        );
    }
}

// 3. config.toml wiring. Every template needs its block, pointing at the right file, carrying
//    the subject the module renders. Subjects are the one part of the copy that does NOT live
//    in the HTML, so this is the only thing stopping them rotting.
const config = readFileSync(configPath, "utf8");
for (const t of GO_TEMPLATES) {
    const block = new RegExp(
        `\\[auth\\.email\\.template\\.${t.configKey}\\]([\\s\\S]*?)(?=\\n\\[|$)`,
    ).exec(config);
    if (!block || !block[1]) {
        fail(
            `supabase/config.toml has no [auth.email.template.${t.configKey}] block, so ${t.file} is never used.`,
        );
        continue;
    }
    const body = block[1];
    const expectedPath = `./supabase/templates/${t.file}`;
    if (!body.includes(`content_path = "${expectedPath}"`)) {
        fail(
            `[auth.email.template.${t.configKey}] must set content_path = "${expectedPath}".`,
        );
    }
    const subject = /subject = "((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
    const expected = renderGoTemplate(t.kind).subject;
    if (subject !== expected.replace(/"/g, '\\"')) {
        fail(
            `[auth.email.template.${t.configKey}] subject is ${JSON.stringify(subject)}, module renders ${JSON.stringify(expected)}. Update config.toml, and paste the same subject into the hosted dashboard.`,
        );
    }
}

// 4. Link shape. /auth/confirm reads token_hash and type and nothing else, and verifies
//    server-side with verifyOtp. {{ .ConfirmationURL }} would redirect through GoTrue's own
//    verify endpoint instead, which a server route cannot read, and seat claiming would stop.
for (const t of GO_TEMPLATES) {
    const path = join(templateDir, t.file);
    if (!existsSync(path)) continue;
    const html = readFileSync(path, "utf8");
    const linkType = copyFor(t.kind).linkType;
    const expected = `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=${linkType}`;
    if (!html.includes(expected)) {
        fail(`supabase/templates/${t.file} must link to ${expected}`);
    }
    if (html.includes("ConfirmationURL")) {
        fail(
            `supabase/templates/${t.file} uses {{ .ConfirmationURL }}, which breaks the server-side verifyOtp flow. Use the token_hash link.`,
        );
    }
}

// 5. Module purity. The shared module is imported by Deno (the edge function) and by tsx (the
//    build script and the unit test). A runtime-specific import breaks one of the two, and the
//    breakage shows up at deploy time rather than here.
for (const file of readdirSync(moduleDir).filter((f) => f.endsWith(".ts"))) {
    // Strip comments first, or this check trips over the header comments that explain the rule.
    const source = readFileSync(join(moduleDir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
    for (const [pattern, what] of [
        [/\bDeno\./, "Deno."],
        [/from\s+"node:/, "a node: import"],
        [/from\s+"npm:/, "an npm: import"],
    ] as const) {
        if (pattern.test(source)) {
            fail(
                `supabase/functions/_shared/email/${file} uses ${what}. This module must run under both Deno and tsx, so it stays free of runtime-specific imports.`,
            );
        }
    }
}

// 6. House style, on the copy itself. No em dash and no en dash in anything a recipient reads,
//    and no " - " standing in for one.
for (const kind of EMAIL_KINDS) {
    const c = copyFor(kind, {
        ensembleName: "Riverside Singers",
        invitedByName: "Dana",
        displayName: "Dana",
        currentEmail: "old@example.com",
        nextEmail: "new@example.com",
        dualConfirm: true,
    });
    const strings = [
        c.subject,
        c.preheader,
        c.eyebrow,
        c.heading,
        ...c.body,
        ...(c.panel ?? []),
        c.button,
        c.finePrint,
        c.expiry,
    ];
    for (const s of strings) {
        const hit = /[–—]|\s-\s/.exec(s);
        if (hit) {
            fail(
                `copy for ${kind} contains ${JSON.stringify(hit[0])} in: ${JSON.stringify(s)}`,
            );
        }
    }
}

if (failures > 0) {
    console.error(`\n${failures} problem(s).`);
    process.exit(1);
}

console.log(
    `ok    ${GO_TEMPLATES.length} templates match the module, are wired in config.toml, and carry the token_hash link`,
);

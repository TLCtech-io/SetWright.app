// Regenerate supabase/templates/*.html from the shared email module.
//
// The Go templates and the Send Email hook render the same design from the same source. This
// script is what keeps the committed HTML in step with it; scripts/check-email-templates.ts
// fails the build when someone edits the output instead of the source.
//
// Run: npm run email:build
//
// No generated-file banner is written into the output. A comment naming a repo path would ship
// inside every production email, and the copies pasted into the hosted dashboard would carry it
// too. The check script's failure message is where that instruction belongs.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    GO_TEMPLATES,
    renderGoTemplate,
} from "../supabase/functions/_shared/email/authEmail.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = join(root, "supabase", "templates");

for (const t of GO_TEMPLATES) {
    const { html, subject } = renderGoTemplate(t.kind);
    writeFileSync(join(templateDir, t.file), html, "utf8");
    console.log(`wrote  supabase/templates/${t.file}`);
    console.log(`       subject: ${subject}`);
}

console.log(
    `\n${GO_TEMPLATES.length} templates written. Their subjects live in supabase/config.toml, not in the HTML, and must match the lines above. Run "npm run email:check" to confirm.`,
);

// The shared auth-email module: link shape, branch routing, escaping, and house style.
//
// This is the only automated coverage the email surface has. supabase/functions/send-email/index.ts
// carries npm: specifiers and Deno.serve, so it sits outside every typecheck and test tier in the
// repo; that is exactly why the decisions live in messagesForHook and the transport does not.
//
// Run: tsx packages/db/test/authEmail.test.ts  (wired into packages/db's "test" script)

import assert from "node:assert/strict";
import {
    EMAIL_KINDS,
    GO,
    GO_TEMPLATES,
    type HookPayload,
    messagesForHook,
    renderAuthEmail,
    renderGoTemplate,
} from "../../../supabase/functions/_shared/email/authEmail.ts";
import { copyFor } from "../../../supabase/functions/_shared/email/copy.ts";

let checks = 0;
function check(label: string, fn: () => void): void {
    fn();
    checks += 1;
    console.log(`ok    ${label}`);
}

function count(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

/** A hook payload with only the fields the module reads. */
function payload(
    actionType: string,
    over: {
        email?: string;
        newEmail?: string;
        meta?: Record<string, unknown>;
        tokenHash?: string;
        tokenHashNew?: string;
    } = {},
): HookPayload {
    return {
        user: {
            email: over.email ?? "singer@example.com",
            ...(over.newEmail ? { new_email: over.newEmail } : {}),
            user_metadata: over.meta ?? {},
        },
        email_data: {
            token: "305805",
            token_hash: over.tokenHash ?? "7d5b7b1964cf5d388340a7f04f1dbb5e",
            redirect_to: "",
            email_action_type: actionType,
            site_url: "https://app.example.com",
            ...(over.tokenHashNew ? { token_hash_new: over.tokenHashNew } : {}),
        },
    };
}

// --- The link shape. Everything else is cosmetic; this is load-bearing. ------------------

check(
    "every kind renders the token_hash confirm link with its own type",
    () => {
        for (const kind of EMAIL_KINDS) {
            const linkType = copyFor(kind).linkType;
            const { html, text } = renderAuthEmail(kind, {
                siteUrl: "https://app.example.com",
                tokenHash: "abc123",
            });
            const expected = `https://app.example.com/auth/confirm?token_hash=abc123&amp;type=${linkType}`;
            // Three times: the button href, the fallback href, and the fallback's visible text.
            assert.equal(
                count(html, expected),
                3,
                `${kind}: expected the confirm link 3 times, got ${count(html, expected)}`,
            );
            assert.ok(
                text.includes(
                    `https://app.example.com/auth/confirm?token_hash=abc123&type=${linkType}`,
                ),
                `${kind}: the text part must carry the raw link`,
            );
        }
    },
);

check("no kind ever emits ConfirmationURL", () => {
    for (const kind of EMAIL_KINDS) {
        const { html, text } = renderAuthEmail(kind, {
            siteUrl: GO.siteUrl,
            tokenHash: GO.tokenHash,
        });
        assert.ok(!html.includes("ConfirmationURL"), `${kind}: html`);
        assert.ok(!text.includes("ConfirmationURL"), `${kind}: text`);
    }
});

check(
    "the Go surface keeps its placeholders and the runtime surface has none",
    () => {
        for (const t of GO_TEMPLATES) {
            const { html } = renderGoTemplate(t.kind);
            assert.ok(html.includes("{{ .SiteURL }}"), `${t.file}: SiteURL`);
            assert.ok(
                html.includes("{{ .TokenHash }}"),
                `${t.file}: TokenHash`,
            );
        }
        // email_change is the only template that names addresses, and it names both because GoTrue
        // renders it for the current and the new recipient alike.
        const change = renderGoTemplate("email_change_shared").html;
        assert.ok(change.includes("{{ .Email }}"));
        assert.ok(change.includes("{{ .NewEmail }}"));

        for (const kind of EMAIL_KINDS) {
            const { html } = renderAuthEmail(kind, {
                siteUrl: "https://app.example.com",
                tokenHash: "abc123",
                currentEmail: "old@example.com",
                nextEmail: "new@example.com",
            });
            assert.ok(
                !html.includes("{{"),
                `${kind}: a runtime render must expand every slot`,
            );
            assert.ok(
                !html.includes("}}"),
                `${kind}: a runtime render must expand every slot`,
            );
        }
    },
);

check("the logo is served from the same origin as the link", () => {
    const { html } = renderAuthEmail("recovery", {
        siteUrl: "https://app.example.com",
        tokenHash: "abc123",
    });
    assert.ok(
        html.includes(
            'src="https://app.example.com/brand/email-lockup-slate-524x200.png"',
        ),
    );
    assert.ok(
        html.includes('alt="SetWright"'),
        "images-off needs the alt text",
    );
});

// --- Hook routing --------------------------------------------------------------------------

check("one message for each single-recipient type", () => {
    for (const type of ["invite", "magiclink", "recovery", "signup"]) {
        const plan = messagesForHook(payload(type));
        assert.ok(plan.ok, `${type}: expected a plan`);
        assert.equal(plan.messages.length, 1, type);
        assert.equal(plan.messages[0]?.to, "singer@example.com", type);
        assert.ok(plan.messages[0]?.subject, `${type}: needs a subject`);
        assert.ok(plan.messages[0]?.text, `${type}: needs a text part`);
    }
});

check("unhandled action types send nothing rather than a sign-in link", () => {
    // The previous version routed every unhandled type to "Your sign-in link", so a
    // password_changed_notification would have reached the user as a broken confirm link.
    for (const type of [
        "reauthentication",
        "password_changed_notification",
        "email_changed_notification",
        "identity_linked_notification",
        "email",
        "something_new_in_gotrue",
    ]) {
        const plan = messagesForHook(payload(type));
        assert.ok(plan.ok, `${type}: an unhandled type is not an error`);
        assert.equal(plan.messages.length, 0, `${type}: must send nothing`);
    }
});

check(
    "email_change refuses rather than routing a token to a guessed address",
    () => {
        // Deliberately not wired yet. GoTrue sends both token pairs in one call with the field names
        // reversed, so a wrong guess delivers a live one-time token to the wrong inbox. Refusing
        // produces a 500, GoTrue reports the change as failed, and the retry regenerates both tokens.
        const plan = messagesForHook(
            payload("email_change", {
                newEmail: "next@example.com",
                tokenHashNew: "currenthash",
            }),
        );
        assert.equal(plan.ok, false);
        assert.ok(!plan.ok && plan.reason.includes("email_change"));
    },
);

check(
    "a missing token_hash or recipient refuses, never sends a partial plan",
    () => {
        const noToken = messagesForHook(payload("invite", { tokenHash: "" }));
        assert.equal(noToken.ok, false);
        const noRecipient = messagesForHook(payload("invite", { email: "" }));
        assert.equal(noRecipient.ok, false);
    },
);

check("invite branches on invite_kind, never on pending_ensemble_name", () => {
    const member = messagesForHook(
        payload("invite", {
            meta: {
                invite_kind: "member",
                invited_ensemble_name: "Riverside Singers",
            },
        }),
    );
    assert.ok(member.ok);
    assert.equal(
        member.messages[0]?.subject,
        "Your seat with Riverside Singers is ready",
    );

    const director = messagesForHook(
        payload("invite", {
            meta: {
                invite_kind: "director",
                pending_ensemble_name: "Harmony Collective",
                display_name: "Dana",
            },
        }),
    );
    assert.ok(director.ok);
    assert.equal(
        director.messages[0]?.subject,
        "Set up Harmony Collective on SetWright",
    );
    assert.ok(director.messages[0]?.html.includes("Hi Dana."));

    // The misroute this guards: SignupForm stamps pending_ensemble_name with the signer-up's own
    // typed group name, and GoTrue refuses an invite only for a CONFIRMED user, so an unconfirmed
    // self-signup account can still be invited to someone else's seat while carrying that key.
    // Branching on it would tell a singer they are being set up to run an ensemble.
    const misroute = messagesForHook(
        payload("invite", {
            meta: { pending_ensemble_name: "Not Their Group" },
        }),
    );
    assert.ok(misroute.ok);
    assert.equal(
        misroute.messages[0]?.subject,
        "Your SetWright account is ready to claim",
        "no invite_kind must fall to the dual-honest shared copy",
    );
    assert.ok(!misroute.messages[0]?.html.includes("Not Their Group"));
});

check("a member invite with no ensemble name still reads correctly", () => {
    const plan = messagesForHook(
        payload("invite", { meta: { invite_kind: "member" } }),
    );
    assert.ok(plan.ok);
    assert.equal(plan.messages[0]?.subject, "Claim your seat on SetWright");
    assert.ok(plan.messages[0]?.html.includes("A director has invited you"));
});

check("the inviter's name appears only when it is present", () => {
    const withInviter = renderAuthEmail("invite_member", {
        siteUrl: "https://app.example.com",
        tokenHash: "abc123",
        ensembleName: "Riverside Singers",
        invitedByName: "Dana",
    }).html;
    assert.ok(withInviter.includes("Invited by Dana"));
    assert.ok(
        withInviter.includes("Dana has given you a seat in Riverside Singers"),
    );

    const without = renderAuthEmail("invite_member", {
        siteUrl: "https://app.example.com",
        tokenHash: "abc123",
        ensembleName: "Riverside Singers",
    }).html;
    assert.ok(!without.includes("Invited by"));
    assert.ok(
        without.includes("You have been given a seat in Riverside Singers"),
    );
});

// --- Escaping. An ensemble name is free-form text a director types. ------------------------

check("markup in an ensemble name is escaped, and never reaches a link", () => {
    const evil = "<script>alert(1)</script>";
    const { html, subject } = renderAuthEmail("invite_member", {
        siteUrl: "https://app.example.com",
        tokenHash: "abc123",
        ensembleName: evil,
    });
    assert.ok(!html.includes("<script>"), "the raw tag must not survive");
    assert.ok(
        html.includes("&lt;script&gt;"),
        "it must survive as escaped text",
    );
    // A subject is a plain-text header, so angle brackets are dropped there rather than escaped.
    assert.ok(!subject.includes("<"), "no angle brackets in a subject");
    assert.ok(!subject.includes(">"), "no angle brackets in a subject");
    assert.ok(subject.includes("alert(1)"), "the rest of the name still reads");
    for (const href of html.match(/href="[^"]*"/g) ?? []) {
        assert.ok(
            !href.includes("script"),
            `the name must reach no href: ${href}`,
        );
    }
});

check(
    "quotes and ampersands in a name cannot break out of an attribute",
    () => {
        const { html } = renderAuthEmail("invite_member", {
            siteUrl: "https://app.example.com",
            tokenHash: "abc123",
            ensembleName: 'Bell & Book " Choir',
        });
        assert.ok(html.includes("Bell &amp; Book &quot; Choir"));
    },
);

check("CR and LF are stripped from a subject", () => {
    const { subject } = renderAuthEmail("invite_member", {
        siteUrl: "https://app.example.com",
        tokenHash: "abc123",
        ensembleName: "Riverside\r\nBcc: attacker@example.com",
    });
    assert.ok(!subject.includes("\r"), "no carriage return");
    assert.ok(!subject.includes("\n"), "no line feed");
});

check("an overlong name is capped", () => {
    const { subject, html } = renderAuthEmail("invite_member", {
        siteUrl: "https://app.example.com",
        tokenHash: "abc123",
        ensembleName: "A".repeat(500),
    });
    assert.ok(subject.length <= 120, `subject was ${subject.length}`);
    assert.ok(
        !html.includes("A".repeat(120)),
        "the name must not survive at full length",
    );
});

// --- House style, enforced rather than reviewed --------------------------------------------

const BANNED_WORDS = [
    "leverage",
    "seamless",
    "robust",
    "transformative",
    "holistic",
    "game-changing",
    "moreover",
    "furthermore",
    "additionally",
];

check("no em dash, no en dash, and no hyphen standing in for one", () => {
    for (const kind of EMAIL_KINDS) {
        for (const s of copyStrings(kind)) {
            const hit = /[–—]|\s-\s/.exec(s);
            assert.equal(
                hit,
                null,
                `${kind}: ${JSON.stringify(hit?.[0])} in ${JSON.stringify(s)}`,
            );
        }
    }
});

check("no banned buzzword or filler transition", () => {
    for (const kind of EMAIL_KINDS) {
        for (const s of copyStrings(kind)) {
            for (const word of BANNED_WORDS) {
                assert.ok(
                    !new RegExp(`\\b${word}\\b`, "i").test(s),
                    `${kind}: "${word}" in ${JSON.stringify(s)}`,
                );
            }
        }
    }
});

check("no email states how long a link lasts", () => {
    // otp_expiry is set in supabase/config.toml for the LOCAL stack only, and config push is
    // forbidden, so the hosted expiry is whatever the dashboard says and this repo cannot see it.
    for (const kind of EMAIL_KINDS) {
        for (const s of copyStrings(kind)) {
            assert.ok(
                !/\b(hour|hours|minute|minutes|24\s*h|day|days)\b/i.test(s),
                `${kind} states a duration it cannot verify: ${JSON.stringify(s)}`,
            );
        }
    }
});

check(
    "every Go template kind is distinct and covers the five config blocks",
    () => {
        assert.equal(GO_TEMPLATES.length, 5);
        assert.equal(new Set(GO_TEMPLATES.map((t) => t.kind)).size, 5);
        assert.equal(new Set(GO_TEMPLATES.map((t) => t.file)).size, 5);
        assert.deepEqual(GO_TEMPLATES.map((t) => t.configKey).sort(), [
            "confirmation",
            "email_change",
            "invite",
            "magic_link",
            "recovery",
        ]);
    },
);

function copyStrings(kind: (typeof EMAIL_KINDS)[number]): string[] {
    const c = copyFor(kind, {
        ensembleName: "Riverside Singers",
        invitedByName: "Dana",
        displayName: "Dana",
        currentEmail: "old@example.com",
        nextEmail: "new@example.com",
        dualConfirm: true,
    });
    return [
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
}

console.log(`\n${checks} checks passed`);

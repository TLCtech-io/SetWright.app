// Supabase Auth "Send Email" hook: production email delivery through Resend.
//
// When the hook is enabled (Dashboard, Authentication, Hooks), GoTrue calls this function
// INSTEAD of its own templating for every auth email, and the dashboard's email editor goes
// dead. When it is disabled, this function is never called and the Go templates in
// supabase/templates/ are what renders.
//
// Locally the hook stays off on purpose (see the commented [auth.hook.send_email] block in
// supabase/config.toml) so GoTrue captures everything in Mailpit at :54324 and the whole
// invite and claim flow is testable without a Resend account.
//
// This file is the transport: verify the signature, ask the shared module what to send, hand
// it to Resend. Every decision worth testing lives in messagesForHook, in
// supabase/functions/_shared/email/authEmail.ts, because this file carries npm: specifiers and
// Deno.serve and so sits outside every typecheck and test tier in the repo.
//
// Secrets (supabase secrets set): RESEND_API_KEY, SEND_EMAIL_HOOK_SECRET, and SEND_EMAIL_FROM
// (a verified Resend sender). The default sender below is Resend's shared sandbox domain,
// which only delivers to the Resend account owner's own address, so it is a development
// default and never a production one.

import { Webhook } from "npm:standardwebhooks@1.0.0";
import { Resend } from "npm:resend@4.0.0";
import {
    type HookPayload,
    messagesForHook,
} from "../_shared/email/authEmail.ts";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

// GoTrue signs with this secret (Standard Webhooks). It is issued as "v1,whsec_<base64>" and
// the verifier wants the base64 part alone. Trim first: a secret set from a file arrives with
// a trailing newline, and @stablelib/base64 rejects it rather than ignoring it.
const hookSecret = (Deno.env.get("SEND_EMAIL_HOOK_SECRET") ?? "")
    .trim()
    .replace(/^v1,whsec_/, "");

const fromAddress =
    Deno.env.get("SEND_EMAIL_FROM") ?? "SetWright <onboarding@resend.dev>";

function errorResponse(httpCode: number, message: string): Response {
    return new Response(
        JSON.stringify({ error: { http_code: httpCode, message } }),
        {
            status: httpCode,
            headers: { "content-type": "application/json" },
        },
    );
}

Deno.serve(async (req) => {
    if (req.method !== "POST")
        return new Response("not found", { status: 404 });

    // Without a secret every request fails verification, so every auth email in production
    // dies with a 401 that looks exactly like a forged request. Say which it is: the fix
    // (set the secret) is nothing like the fix for a real signature failure.
    if (!hookSecret) {
        console.error(
            "[send-email] SEND_EMAIL_HOOK_SECRET is not set, so no email can be verified or sent",
        );
        return errorResponse(500, "email delivery is not configured");
    }

    const payload = await req.text();
    const headers = Object.fromEntries(req.headers);

    let data: HookPayload;
    try {
        data = new Webhook(hookSecret).verify(payload, headers) as HookPayload;
    } catch (e) {
        // "Missing required headers" means a malformed request; "No matching signature found"
        // means the secret does not match what GoTrue signed with. A run of the latter is a
        // misconfiguration, not an attack, and the log line is the only place to tell them apart.
        console.error(
            "[send-email] signature verification failed:",
            e instanceof Error ? e.message : String(e),
        );
        return errorResponse(401, "invalid signature");
    }

    const plan = messagesForHook(data);
    if (!plan.ok) {
        // GoTrue surfaces this to the caller and does NOT fall back to SMTP, so a 500 means no
        // email is sent at all. That is the intended outcome here: the module refuses only when
        // sending would mean guessing which address a one-time token belongs to.
        console.error(
            `[send-email] refusing ${data.email_data?.email_action_type}: ${plan.reason}`,
        );
        return errorResponse(500, "email could not be prepared");
    }

    if (plan.messages.length === 0) {
        console.warn(
            `[send-email] no message defined for action type "${data.email_data?.email_action_type}"; nothing sent`,
        );
        return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }

    // A plan can carry more than one message (an email change confirms from both addresses).
    // Send them together, then report failure if ANY leg failed. Never 200 on a partial send:
    // a half-delivered email change leaves the user waiting on a message that will never arrive.
    const results = await Promise.allSettled(
        plan.messages.map((m) =>
            resend.emails
                .send({
                    from: fromAddress,
                    to: [m.to],
                    subject: m.subject,
                    html: m.html,
                    text: m.text,
                })
                .then((r) => {
                    if (r.error)
                        throw new Error(`${r.error.name}: ${r.error.message}`);
                    return r;
                }),
        ),
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
        for (const f of failed) {
            console.error(
                "[send-email] Resend send failed:",
                (f as PromiseRejectedResult).reason,
            );
        }
        // Generic to the caller: the Resend error text can name recipient addresses and account
        // state, and GoTrue puts this message in front of the user.
        return errorResponse(
            500,
            failed.length === results.length
                ? "email could not be sent"
                : "email was only partly sent",
        );
    }

    return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
});

// The HTML email shell, plus the escaping every interpolated value goes through.
//
// One 600px table-based document. Inline styles carry the design; the <style> block only
// enhances, because the Gmail app strips <style> for non-Gmail accounts and Outlook on
// Windows renders through Word. Nothing that matters depends on either.
//
// Colours are the app's own tokens from apps/web/app/globals.css, so email light and dark
// are the same design as the app's Nickel and Gunmetal. The button is --clay-deep #c64e36,
// not --clay #e0654c, because white text fails AA at 3.42 on the lighter clay and clears
// it at 4.62 on the deeper one. globals.css sets --accent-btn the same way for the same reason.
//
// No @font-face. Outlook on Windows has no web font support, Gmail strips the <style> that
// would carry it, and Apple Mail Privacy Protection proxies the request. The brand's
// typography ships as outlined vector inside the logo PNG, which is where it has to be exact.

const FONT =
    "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** The email lockup: the reversed mark matted onto opaque Slate Ink, displayed at 262 x 100.
 *  Matted rather than transparent because no mail client recolours bitmap pixels, so a matted
 *  tile renders the same everywhere, while a transparent white wordmark loses its ground under
 *  any client transform that lightens the band behind it. The filename carries the intrinsic
 *  size and must not be reused for different artwork: Gmail's image proxy caches hard. */
export const LOGO_PATH = "/brand/email-lockup-slate-524x200.png";
export const LOGO_DISPLAY_WIDTH = 262;
export const LOGO_DISPLAY_HEIGHT = 100;

/** Escape for HTML text and double-quoted attribute contexts. */
export function esc(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** Flatten a value for a header line: strip control characters (CR and LF above all, which
 *  would let a crafted ensemble name inject a header), collapse runs of whitespace, and cap
 *  the length. Used on every subject. */
export function sanitizeText(value: string, max = 120): string {
    const flat = value
        .replace(/[\u0000-\u001F\u007F]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Flatten a value for use as a subject line.
 *
 *  A subject is a plain-text header, not markup, so angle brackets carry no meaning there and are
 *  dropped rather than escaped. That is presentation, not protection: an ensemble name reaching an
 *  inbox as "Your seat with <script>alert(1)</script> is ready" reads as a broken or hostile
 *  message. The body takes the opposite treatment and escapes, so the name survives as written. */
export function subjectLine(value: string, max = 120): string {
    return sanitizeText(value.replace(/[<>]/g, ""), max);
}

/** The one link shape every template must produce. /auth/confirm reads token_hash and type
 *  and nothing else, and verifies server-side with verifyOtp. Never {{ .ConfirmationURL }}:
 *  that redirects through GoTrue's own verify endpoint, which a server route cannot read. */
export function confirmUrl(
    siteUrl: string,
    tokenHash: string,
    type: string,
): string {
    return `${siteUrl}/auth/confirm?token_hash=${tokenHash}&type=${type}`;
}

export interface ShellParts {
    subject: string;
    preheader: string;
    eyebrow: string;
    heading: string;
    body: string[];
    panel?: string[];
    button: string;
    /** The confirm link, unescaped. */
    buttonUrl: string;
    finePrint: string;
    expiry: string;
    /** Origin the logo is served from. The app's own, so the link and the image share a host. */
    siteUrl: string;
}

export function renderShell(p: ShellParts): string {
    const url = esc(p.buttonUrl);
    const logo = esc(`${p.siteUrl}${LOGO_PATH}`);

    const paragraphs = p.body
        .map(
            (text) =>
                `          <p class="sw-text" style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:25px;color:#1f2733;">${esc(text)}</p>`,
        )
        .join("\n");

    const panel = p.panel?.length
        ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
            <tr>
              <td class="sw-panel" bgcolor="#eaf2f3" style="padding:16px 20px;border-radius:9px;border:1px solid #cfe2e4;">
${p.panel
    .map(
        (line, i) =>
            `                <div class="${i === 0 ? "sw-text" : "sw-muted"}" style="font-family:${FONT};font-size:${i === 0 ? "17px" : "14px"};line-height:${i === 0 ? "24px" : "20px"};font-weight:${i === 0 ? "600" : "400"};color:${i === 0 ? "#1f2733" : "#545d69"};">${esc(line)}</div>`,
    )
    .join("\n")}
              </td>
            </tr>
          </table>
`
        : "";

    return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(p.subject)}</title>
<!--[if mso]>
<xml><o:OfficeDocumentSettings xmlns:o="urn:schemas-microsoft-com:office:office">
<o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
<style>* { font-family: 'Segoe UI', Arial, sans-serif !important; }</style>
<![endif]-->
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
  img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
  a { color: #2a6f7a; }
  @media only screen and (max-width: 620px) {
    .sw-card { width: 100% !important; max-width: 100% !important; }
    .sw-pad  { padding-left: 22px !important; padding-right: 22px !important; }
    .sw-head { padding-left: 12px !important; padding-right: 12px !important; }
    .sw-logo { max-width: 100% !important; height: auto !important; }
  }
  @media (prefers-color-scheme: dark) {
    .sw-page                 { background-color: #0e131a !important; }
    .sw-card, .sw-surface    { background-color: #131a23 !important; }
    .sw-card                 { border-color: #28323f !important; }
    .sw-text                 { color: #e7ebf0 !important; }
    .sw-muted                { color: #8b95a3 !important; }
    .sw-rule                 { background-color: #202a35 !important; }
    .sw-panel                { background-color: #15242a !important; border-color: #294249 !important; }
    .sw-link, .sw-link a     { color: #83bcc5 !important; }
  }
</style>
</head>
<body class="sw-page" style="margin:0;padding:0;width:100%;background-color:#dbe1e9;">
  <div style="display:none;font-size:1px;color:#dbe1e9;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(p.preheader)}</div>
  <div style="display:none;font-size:1px;color:#dbe1e9;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
  <table role="presentation" class="sw-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#dbe1e9" style="background-color:#dbe1e9;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" class="sw-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #ccd3db;border-radius:14px;overflow:hidden;">

          <tr>
            <td class="sw-head" align="center" bgcolor="#1f2733" style="background-color:#1f2733;padding:16px 24px;">
              <img class="sw-logo" src="${logo}" width="${LOGO_DISPLAY_WIDTH}" height="${LOGO_DISPLAY_HEIGHT}" alt="SetWright" style="display:block;width:${LOGO_DISPLAY_WIDTH}px;height:${LOGO_DISPLAY_HEIGHT}px;border:0;font-family:${FONT};font-size:22px;font-weight:600;line-height:100px;color:#ffffff;text-align:center;text-decoration:none;">
            </td>
          </tr>
          <tr>
            <td height="3" bgcolor="#c64e36" style="height:3px;line-height:3px;font-size:3px;background-color:#c64e36;">&nbsp;</td>
          </tr>

          <tr>
            <td class="sw-pad sw-surface" style="padding:32px 40px 8px;">
              <div class="sw-muted" style="margin:0 0 10px;font-family:${FONT};font-size:11px;line-height:16px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#545d69;">${esc(p.eyebrow)}</div>
              <h1 class="sw-text" style="margin:0 0 20px;font-family:${FONT};font-size:24px;line-height:31px;font-weight:600;letter-spacing:-0.01em;color:#1f2733;">${esc(p.heading)}</h1>
${paragraphs}
            </td>
          </tr>

          <tr>
            <td class="sw-pad sw-surface" style="padding:8px 40px 0;">
${panel}              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
                <tr>
                  <td align="center" bgcolor="#c64e36" style="background-color:#c64e36;border-radius:9px;">
                    <a href="${url}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:9px;">${esc(p.button)}</a>
                  </td>
                </tr>
              </table>
              <p class="sw-muted" style="margin:0 0 6px;font-family:${FONT};font-size:13px;line-height:19px;color:#545d69;">If the button does not work, copy this address into your browser:</p>
              <p class="sw-link" style="margin:0 0 24px;font-family:${FONT};font-size:13px;line-height:19px;word-break:break-all;color:#2a6f7a;"><a href="${url}" style="color:#2a6f7a;">${url}</a></p>
              <p class="sw-muted" style="margin:0 0 24px;font-family:${FONT};font-size:13px;line-height:19px;color:#545d69;">${esc(p.expiry)}</p>
            </td>
          </tr>

          <tr>
            <td class="sw-pad sw-surface" style="padding:0 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td class="sw-rule" height="1" bgcolor="#e4e8ec" style="height:1px;line-height:1px;font-size:1px;background-color:#e4e8ec;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="sw-pad sw-surface" style="padding:20px 40px 32px;">
              <p class="sw-muted" style="margin:0 0 12px;font-family:${FONT};font-size:13px;line-height:19px;color:#545d69;">${esc(p.finePrint)}</p>
              <p class="sw-muted" style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:#545d69;">SetWright. Setlists your group can actually sing on the night.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

/** The text/plain alternative. Some clients prefer it, some strip HTML links, and a message
 *  with no text part scores worse with spam filters. The URL is raw here, not escaped. */
export function renderText(p: ShellParts): string {
    const lines: string[] = [p.heading, ""];
    for (const para of p.body) lines.push(para, "");
    if (p.panel?.length) lines.push(...p.panel, "");
    lines.push(
        `${p.button}: ${p.buttonUrl}`,
        "",
        p.expiry,
        "",
        p.finePrint,
        "",
    );
    lines.push(
        "SetWright. Setlists your group can actually sing on the night.",
    );
    return lines.join("\n");
}

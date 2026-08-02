// A small presentational pill. Tone picks the color from globals.css.

export type BadgeTone =
    | "ready"
    | "polish"
    | "low"
    | "learn"
    | "explicit"
    | "warn"
    | "plain";

export function Badge({
    label,
    tone = "plain",
}: {
    label: string;
    tone?: BadgeTone;
}) {
    const cls = tone === "plain" ? "badge" : `badge ${tone}`;
    return <span className={cls}>{label}</span>;
}

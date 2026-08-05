import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

// The "Ensemble" type pairing: Hanken Grotesk (display sans — titles, names, prose) + JetBrains Mono
// (everything systemy — uppercase eyebrows, metrics, keys/tempos, badges). Exposed as CSS variables
// that globals.css reads (--font-sans / --font-mono); next/font self-hosts them, no network at runtime.
const sans = Hanken_Grotesk({
    subsets: ["latin"],
    weight: ["400", "500", "600", "700"],
    variable: "--font-sans",
    display: "swap",
});
const mono = JetBrains_Mono({
    subsets: ["latin"],
    weight: ["400", "500", "600", "700"],
    variable: "--font-mono",
    display: "swap",
});

export const metadata: Metadata = {
    title: "SetWright",
    description: "SetWright: setlists for vocal groups.",
    icons: {
        icon: [
            { url: "/favicons/favicon.svg", type: "image/svg+xml" },
            {
                url: "/favicons/favicon-16.png",
                sizes: "16x16",
                type: "image/png",
            },
            {
                url: "/favicons/favicon-32.png",
                sizes: "32x32",
                type: "image/png",
            },
            {
                url: "/favicons/favicon-48.png",
                sizes: "48x48",
                type: "image/png",
            },
            {
                url: "/favicons/favicon-64.png",
                sizes: "64x64",
                type: "image/png",
            },
            {
                url: "/favicons/favicon-192.png",
                sizes: "192x192",
                type: "image/png",
            },
            {
                url: "/favicons/favicon-256.png",
                sizes: "256x256",
                type: "image/png",
            },
            {
                url: "/favicons/favicon-512.png",
                sizes: "512x512",
                type: "image/png",
            },
        ],
        apple: [
            {
                url: "/favicons/favicon-180.png",
                sizes: "180x180",
                type: "image/png",
            },
        ],
        shortcut: ["/favicon.ico"],
    },
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html
            lang="en"
            className={`${sans.className} ${mono.className}`}
            style={
                {
                    "--font-sans": sans.style.fontFamily,
                    "--font-mono": mono.style.fontFamily,
                } as React.CSSProperties
            }
        >
            <body>
                {/* Inside an ensemble, account controls (switcher, profile, sign out) live in the
            nav's avatar menu. The signed-in AuthBar is mounted only on the /ensembles picker,
            the one signed-in page with no nav. */}
                {children}
                <SpeedInsights />
                <Analytics />
            </body>
        </html>
    );
}

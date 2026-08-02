import path from 'node:path';
import type { NextConfig } from 'next';

// core and api ship their TypeScript source (main/types point at ./src). Let
// Next compile that source for the browser bundle. Both must be listed: api
// re-exports and imports core.
//
// That source uses NodeNext relative imports with a `.js` extension
// ("./pitch.js" for pitch.ts). The bundler has to map `.js` back to the real
// `.ts`/`.tsx` file. webpack's extensionAlias does exactly that, so this build
// runs on webpack (see the --webpack flag in package.json).
const nextConfig: NextConfig = {
  // Pin the file-tracing root to this repo. Without it Next walks up and can pick a stray
  // parent lockfile (e.g. one in $HOME) as the workspace root — the "inferred your
  // workspace root" build warning. import.meta.dirname is apps/web, so '..','..' is the repo.
  outputFileTracingRoot: path.join(import.meta.dirname, '..', '..'),
  transpilePackages: ['@repertoire/core', '@repertoire/api'],
  // Baseline security headers on every response. HSTS pins clients to HTTPS (browsers ignore
  // it over plain HTTP/localhost, so it is safe to always send); the rest blunt MIME-sniffing,
  // clickjacking, and referrer leakage. CSRF is covered separately by the SameSite=Lax session
  // cookies (see proxy.ts) — a cross-site POST/fetch never carries them.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // A conservative CSP backstop: session cookies are JS-readable by @supabase/ssr
          // design, so if XSS ever lands this is what limits the blast radius. No script-src
          // yet (Next inlines scripts); frame-ancestors supersedes X-Frame-Options above.
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
          },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;

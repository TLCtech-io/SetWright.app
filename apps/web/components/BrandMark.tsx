// The SetWright lockup (mark + wordmark), the identity header for the auth/entry pages,
// mirroring the nav's brand link. The reversed (light-ink) file swaps in on a dark ground via
// prefers-color-scheme, same as the rest of the app's theming, no JS needed. A shared component
// (no 'use client'), so it renders in both the server pages and the client welcome form.
export function BrandMark() {
    return (
        <div className="auth-brand">
            <picture>
                <source
                    srcSet="/brand/lockup-horizontal-reversed.svg"
                    media="(prefers-color-scheme: dark)"
                />
                <img
                    src="/brand/lockup-horizontal.svg"
                    alt="SetWright"
                    width="1024"
                    height="263"
                />
            </picture>
        </div>
    );
}

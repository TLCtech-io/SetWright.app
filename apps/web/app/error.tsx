"use client";

// Root error boundary. A thrown data-layer error renders this instead of Next's
// bare default screen, so the user keeps the app's chrome, a retry, and a way out.
export default function RootError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <main className="page">
            <div className="page-head">
                <div>
                    <h1>Something went wrong</h1>
                    <div className="sub">
                        The server hit an unexpected error while loading this
                        page.
                    </div>
                </div>
            </div>
            <p className="callout shortfall">
                {error.digest
                    ? `Reference: ${error.digest}`
                    : "An unexpected error occurred."}{" "}
                Try again, or head back and retrace your steps.
            </p>
            <div className="form-actions">
                <button type="button" className="perform" onClick={reset}>
                    Try again
                </button>
                <a href="/" className="ctl">
                    Go home
                </a>
            </div>
        </main>
    );
}

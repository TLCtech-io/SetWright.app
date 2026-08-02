import { SkPageHead, Sk } from "@/components/Skeletons";

// Playground: head with action, then a grid of draft rows (body text + one action).
export default function PlaygroundLoading() {
    return (
        <main
            className="page hub skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkPageHead action />
            <div className="rep-list rep-grid">
                {[220, 160, 260, 190, 230].map((meta, i) => (
                    <div className="rep-row" key={i}>
                        <div className="rep-body">
                            <Sk w={180} h={16} />
                            <Sk w={meta} h={11} style={{ marginTop: 8 }} />
                        </div>
                        <div className="rep-actions">
                            <Sk w={70} h={30} r={8} />
                        </div>
                    </div>
                ))}
            </div>
        </main>
    );
}

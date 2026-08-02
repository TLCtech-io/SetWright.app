import { SkPageHead, Sk, SkCardGrid } from "@/components/Skeletons";

// Member home: head, next-up banner, three menu cards, then the solos strip.
export default function MeLoading() {
    return (
        <main
            className="page hub-menu skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkPageHead />
            <Sk
                w="100%"
                h={92}
                r={14}
                style={{ display: "block", marginTop: 16 }}
            />
            <SkCardGrid count={3} />
            <section className="me-solos">
                <div className="me-solos-head">
                    <Sk w={110} h={20} />
                    <Sk w={150} h={13} />
                </div>
                <Sk
                    w="100%"
                    h={14}
                    style={{ display: "block", marginTop: 14 }}
                />
                <Sk
                    w="100%"
                    h={14}
                    style={{ display: "block", marginTop: 10 }}
                />
                <Sk
                    w="100%"
                    h={14}
                    style={{ display: "block", marginTop: 10 }}
                />
            </section>
        </main>
    );
}

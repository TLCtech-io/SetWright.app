import { SkPageHead, Sk } from "@/components/Skeletons";

// Ensembles picker: head, a list of three ensemble rows, then the create block.
export default function EnsemblesLoading() {
    return (
        <main
            className="page ensembles-page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkPageHead />
            <ul className="ensemble-list">
                {[0, 1, 2].map((i) => (
                    <li key={i}>
                        <Sk w={180} h={16} />
                        <Sk w={70} h={20} r={6} />
                        <Sk w={80} h={30} r={8} />
                    </li>
                ))}
            </ul>
            <Sk
                w="100%"
                h={38}
                r={9}
                style={{ display: "block", marginTop: 16 }}
            />
            <Sk
                w={140}
                h={40}
                r={9}
                style={{ display: "block", marginTop: 12 }}
            />
        </main>
    );
}

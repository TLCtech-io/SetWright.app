import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { EnsembleSettingsForm } from "@/components/EnsembleSettingsForm";

// Reads the mutable ensemble row, so it renders per request.
export const dynamic = "force-dynamic";

export default async function GeneralSettingsPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const settings = await getRepository().getEnsembleSettings();
    return (
        <main className="page form-page">
            <Link href={`/e/${ensembleId}/settings`} className="back-link">
                &larr; Settings
            </Link>
            <div className="page-head">
                <h1>General</h1>
            </div>
            <EnsembleSettingsForm initial={settings} />
        </main>
    );
}

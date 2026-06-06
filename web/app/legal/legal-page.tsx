import Link from "next/link";

export function LegalPage({
    eyebrow,
    title,
    summary,
    sections,
}: {
    eyebrow: string;
    title: string;
    summary: string;
    sections: Array<{ heading: string; body: string[] }>;
}) {
    return (
        <div className="mx-auto max-w-[960px] px-6 py-10 md:py-14">
            <Link
                href="/"
                className="text-[12px] text-text-mute hover:text-text-dim transition-colors"
            >
                ← markets
            </Link>

            <header className="mt-6 border-b border-border pb-6">
                <div className="flex items-baseline gap-3 mb-3">
                    <span className="section-number text-[11px] tabular">00</span>
                    <span className="text-[11px] uppercase tracking-[0.24em] text-text-mute num">
                        {eyebrow}
                    </span>
                </div>
                <h1 className="text-[30px] md:text-[40px] leading-[1.05] tracking-tight font-medium text-text max-w-[18ch]">
                    {title}
                </h1>
                <p className="mt-4 max-w-[62ch] text-[13px] leading-[1.7] text-text-dim">
                    {summary}
                </p>
            </header>

            <div className="mt-8 space-y-6">
                {sections.map((section) => (
                    <section key={section.heading} className="border border-border bg-bg-elev/40">
                        <div className="border-b border-border px-5 py-2.5">
                            <h2 className="text-[10px] uppercase tracking-[0.22em] text-text-mute">
                                / {section.heading.toLowerCase()}
                            </h2>
                        </div>
                        <div className="px-5 py-4 space-y-4">
                            {section.body.map((paragraph) => (
                                <p key={paragraph} className="text-[13px] leading-[1.7] text-text-dim">
                                    {paragraph}
                                </p>
                            ))}
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}

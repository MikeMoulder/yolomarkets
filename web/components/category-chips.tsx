"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

type Chip = { label: string; count: number };

type Props = {
    chips: Chip[];
    /** Total count across all categories — used for the "All" chip. */
    total: number;
};

/** URL-driven category filter. Selected state from `?cat=Politics`. */
export function CategoryChips({ chips, total }: Props) {
    const sp = useSearchParams();
    const current = sp.get("cat") ?? "";
    const sortQ = sp.get("sort");
    const qQ = sp.get("q");

    function buildHref(cat: string): string {
        const next = new URLSearchParams();
        if (cat) next.set("cat", cat);
        if (sortQ) next.set("sort", sortQ);
        if (qQ) next.set("q", qQ);
        const str = next.toString();
        return str ? `/?${str}` : "/";
    }

    return (
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-6 px-6 py-1">
            <Chip
                href={buildHref("")}
                active={current === ""}
                label="All"
                count={total}
            />
            {chips.map((c) => (
                <Chip
                    key={c.label}
                    href={buildHref(c.label)}
                    active={current === c.label}
                    label={c.label}
                    count={c.count}
                />
            ))}
        </div>
    );
}

function Chip({
    href,
    active,
    label,
    count,
}: {
    href: string;
    active: boolean;
    label: string;
    count: number;
}) {
    return (
        <Link
            href={href}
            scroll={false}
            className={[
                "shrink-0 inline-flex items-center gap-2 px-3.5 h-8 text-[12px] border transition-all whitespace-nowrap rounded-full",
                active
                    ? "bg-text text-bg border-text shadow-[0_4px_14px_-6px_rgba(255,255,255,0.25)]"
                    : "bg-bg-elev/60 text-text-dim border-border hover:border-border-strong hover:text-text hover:bg-bg-elev",
            ].join(" ")}
        >
            <span>{label}</span>
            <span
                className={[
                    "num text-[10.5px] tabular tracking-tight",
                    active ? "text-bg/70" : "text-text-faint",
                ].join(" ")}
            >
                {count}
            </span>
        </Link>
    );
}

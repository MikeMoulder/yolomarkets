"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";

const OPTIONS = [
    { value: "volume24hr", label: "Trending" },
    { value: "volume", label: "Total volume" },
    { value: "endDate", label: "Ending soon" },
] as const;

export type SortValue = (typeof OPTIONS)[number]["value"];

export function SortSelect() {
    const sp = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const current = (sp.get("sort") ?? "volume24hr") as SortValue;

    function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
        const next = new URLSearchParams(sp.toString());
        if (e.target.value === "volume24hr") next.delete("sort");
        else next.set("sort", e.target.value);
        router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    }

    return (
        <div className="relative">
            <select
                value={current}
                onChange={onChange}
                aria-label="sort markets"
                className="h-8 pl-3.5 pr-8 bg-bg-elev border border-border hover:border-border-strong text-[12px] text-text appearance-none cursor-pointer outline-none rounded-full transition-colors"
            >
                {OPTIONS.map((o) => (
                    <option key={o.value} value={o.value} className="bg-bg-elev text-text">
                        {o.label}
                    </option>
                ))}
            </select>
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-mute text-[10px] num pointer-events-none">
                ▾
            </span>
        </div>
    );
}

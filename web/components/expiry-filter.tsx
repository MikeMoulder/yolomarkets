"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

const OPTIONS = [
    { value: "all", label: "All expiries" },
    { value: "24h", label: "Next 24h" },
    { value: "7d", label: "Next 7d" },
    { value: "30d", label: "Next 30d" },
    { value: "90d", label: "Next 90d" },
] as const;

export type ExpiryValue = (typeof OPTIONS)[number]["value"];

export function ExpiryFilter() {
    const sp = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const current = (sp.get("expiry") ?? "all") as ExpiryValue;

    function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
        const next = new URLSearchParams(sp.toString());
        if (e.target.value === "all") next.delete("expiry");
        else next.set("expiry", e.target.value);
        router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    }

    return (
        <div className="relative">
            <select
                value={current}
                onChange={onChange}
                aria-label="filter by expiry"
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

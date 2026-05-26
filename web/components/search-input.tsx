"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useTransition, useState, useEffect } from "react";

/** URL-synced search input. Debounced; updates `?q=...` without scrolling. */
export function SearchInput() {
    const sp = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const initial = sp.get("q") ?? "";
    const [value, setValue] = useState(initial);
    const [, startTransition] = useTransition();

    // Keep state in sync if the URL changes externally (back/forward).
    useEffect(() => {
        setValue(sp.get("q") ?? "");
    }, [sp]);

    useEffect(() => {
        const timer = setTimeout(() => {
            const next = new URLSearchParams(sp.toString());
            if (value.trim()) next.set("q", value.trim());
            else next.delete("q");
            startTransition(() => {
                router.replace(`${pathname}?${next.toString()}`, { scroll: false });
            });
        }, 180);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    return (
        <div className="relative w-full max-w-md">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-faint text-[11px] uppercase tracking-[0.18em] num pointer-events-none">
                /
            </span>
            <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="search markets, tags, options"
                aria-label="search markets"
                className="w-full h-10 pl-8 pr-3 bg-bg-elev border border-border focus:border-border-bright text-[13px] text-text placeholder:text-text-faint outline-none transition-colors num rounded-full"
            />
            {value && (
                <button
                    onClick={() => setValue("")}
                    aria-label="clear search"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-text-mute hover:text-text text-[12px] num"
                >
                    ✕
                </button>
            )}
        </div>
    );
}

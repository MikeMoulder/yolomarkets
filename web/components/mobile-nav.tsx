"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const TABS = [
    { href: "/", label: "Markets", icon: MarketsIcon },
    { href: "/markets/fast", label: "Fast", icon: BoltIcon },
    { href: "/portfolio", label: "Portfolio", icon: PieIcon },
    { href: "/agent", label: "Agent", icon: SparkIcon },
] as const;

/** Tracks scroll direction for the iOS-style collapse. Returns true when the
 *  user is scrolling down (away from the top) — the dock shrinks — and false
 *  when scrolling up or near the top, where it expands back. rAF-throttled,
 *  passive listener, with a small threshold so tiny jitters don't toggle it. */
function useScrollCollapsed(): boolean {
    const [collapsed, setCollapsed] = useState(false);

    useEffect(() => {
        let last = window.scrollY;
        let ticking = false;
        function onScroll() {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                const y = window.scrollY;
                const delta = y - last;
                if (y < 48) setCollapsed(false);
                else if (delta > 6) setCollapsed(true);
                else if (delta < -6) setCollapsed(false);
                last = y;
                ticking = false;
            });
        }
        window.addEventListener("scroll", onScroll, { passive: true });
        return () => window.removeEventListener("scroll", onScroll);
    }, []);

    return collapsed;
}

/** Floating frosted-glass dock — the only navigation on phones (the header
 *  nav is hidden below `md`). iOS behaviour: it rides full-size at the top of
 *  a page and shrinks to a compact icons-only capsule as you scroll down,
 *  springing back when you scroll up. A frosted highlight glides to the
 *  active tab. Sits above the page but below modals. */
export function MobileNav() {
    const pathname = usePathname();
    const collapsed = useScrollCollapsed();
    const activeIndex = TABS.findIndex((tab) =>
        tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href),
    );

    return (
        <nav
            className={`fixed left-1/2 z-40 w-[min(calc(100%-48px),312px)] origin-bottom -translate-x-1/2 transition-transform duration-300 ease-out md:hidden ${
                collapsed ? "scale-[0.88]" : "scale-100"
            }`}
            style={{ bottom: "calc(env(safe-area-inset-bottom) + 10px)" }}
            aria-label="Primary"
        >
            <div className="glass-dock rounded-[22px] p-1">
                <div className="relative grid grid-cols-4">
                    {/* Frosted selection highlight — slides to the active tab */}
                    <span
                        aria-hidden
                        className={`glass-blob absolute inset-y-0 left-0 w-1/4 rounded-[18px] ${
                            activeIndex < 0 ? "opacity-0" : "opacity-100"
                        }`}
                        style={{
                            transform: `translateX(${Math.max(activeIndex, 0) * 100}%)`,
                        }}
                    />
                    {TABS.map((tab) => {
                        const active =
                            tab.href === "/"
                                ? pathname === "/"
                                : pathname.startsWith(tab.href);
                        const Icon = tab.icon;
                        return (
                            <Link
                                key={tab.href}
                                href={tab.href}
                                aria-current={active ? "page" : undefined}
                                className={[
                                    "relative z-10 flex flex-col items-center rounded-[18px] pt-1.5 pb-1 transition-[color] duration-200 active:scale-[0.9]",
                                    active
                                        ? "text-text"
                                        : "text-text-mute hover:text-text-dim",
                                ].join(" ")}
                            >
                                <span className={active ? "text-accent" : "text-current"}>
                                    <Icon active={active} />
                                </span>
                                <span
                                    className={[
                                        "block overflow-hidden text-[9px] leading-none tracking-wide transition-all duration-300 ease-out",
                                        collapsed
                                            ? "mt-0 max-h-0 opacity-0"
                                            : "mt-1 max-h-3 opacity-100",
                                        active ? "font-medium" : "",
                                    ].join(" ")}
                                >
                                    {tab.label}
                                </span>
                            </Link>
                        );
                    })}
                </div>
            </div>
        </nav>
    );
}

type IconProps = { active: boolean };

/** Four rounded tiles; the top-left tile fills in when active. */
function MarketsIcon({ active }: IconProps) {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[19px] w-[19px]">
            <rect
                x="3.75" y="3.75" width="7" height="7" rx="2.25"
                fill={active ? "currentColor" : "none"}
                fillOpacity={active ? 0.9 : 0}
                stroke="currentColor" strokeWidth="1.6"
            />
            <rect x="13.25" y="3.75" width="7" height="7" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <rect x="3.75" y="13.25" width="7" height="7" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <rect x="13.25" y="13.25" width="7" height="7" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
    );
}

function BoltIcon({ active }: IconProps) {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[19px] w-[19px]">
            <path
                d="M12.6 2.9c.3-.4 1-.2.9.3l-1.2 6.6c0 .2.1.4.3.4h4.2c.4 0 .6.5.4.8l-7.5 9.7c-.3.4-1 .2-.9-.3l1.2-6.6c0-.2-.1-.4-.3-.4H5.5c-.4 0-.6-.5-.4-.8l7.5-9.7Z"
                fill={active ? "currentColor" : "none"}
                fillOpacity={active ? 0.9 : 0}
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
            />
        </svg>
    );
}

/** Donut with a lifted quarter slice — the slice fills when active. */
function PieIcon({ active }: IconProps) {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[19px] w-[19px]">
            <path
                d="M10.5 4.6a8 8 0 1 0 8.9 8.9h-8a.9.9 0 0 1-.9-.9v-8Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
            />
            <path
                d="M14 3.3a8 8 0 0 1 6.7 6.7h-6a.7.7 0 0 1-.7-.7v-6Z"
                fill={active ? "currentColor" : "none"}
                fillOpacity={active ? 0.9 : 0}
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
            />
        </svg>
    );
}

/** Twin four-point sparks — the big one fills when active. */
function SparkIcon({ active }: IconProps) {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[19px] w-[19px]">
            <path
                d="M9.5 4.5c.2-.6 1-.6 1.2 0l1.3 3.9c.1.3.3.5.6.6l3.9 1.3c.6.2.6 1 0 1.2l-3.9 1.3c-.3.1-.5.3-.6.6l-1.3 3.9c-.2.6-1 .6-1.2 0l-1.3-3.9a.95.95 0 0 0-.6-.6L3.7 11.5c-.6-.2-.6-1 0-1.2l3.9-1.3c.3-.1.5-.3.6-.6l1.3-3.9Z"
                fill={active ? "currentColor" : "none"}
                fillOpacity={active ? 0.9 : 0}
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
            />
            <path
                d="M17.5 13.9c.15-.4.75-.4.9 0l.7 2c.05.17.18.3.35.35l2 .7c.4.15.4.75 0 .9l-2 .7a.55.55 0 0 0-.35.35l-.7 2c-.15.4-.75.4-.9 0l-.7-2a.55.55 0 0 0-.35-.35l-2-.7c-.4-.15-.4-.75 0-.9l2-.7a.55.55 0 0 0 .35-.35l.7-2Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
            />
        </svg>
    );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const TABS = [
    { href: "/", label: "Markets", icon: MarketsIcon },
    { href: "/markets/fast", label: "Fast", icon: BoltIcon },
    { href: "/portfolio", label: "Portfolio", icon: PieIcon },
    { href: "/agent", label: "Agent", icon: RobotIcon },
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

/** Four rounded tiles; the top-left tile fills in and pops when active. */
function MarketsIcon({ active }: IconProps) {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[19px] w-[19px]">
            <rect
                x="3.75" y="3.75" width="7" height="7" rx="2.25"
                fill={active ? "currentColor" : "none"}
                fillOpacity={active ? 0.9 : 0}
                stroke="currentColor" strokeWidth="1.6"
                className={active ? "dock-anim dock-pop" : undefined}
            />
            <rect x="13.25" y="3.75" width="7" height="7" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <rect x="3.75" y="13.25" width="7" height="7" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <rect x="13.25" y="13.25" width="7" height="7" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
    );
}

/** Lightning bolt — strikes (wiggles) when the tab activates. */
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
                className={active ? "dock-anim dock-wiggle" : undefined}
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
                className={active ? "dock-anim dock-nudge" : undefined}
            />
        </svg>
    );
}

/** Robot head with antenna — the eyes light up (fill) when active. */
function RobotIcon({ active }: IconProps) {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[19px] w-[19px]">
            {/* antenna */}
            <circle cx="12" cy="3.1" r="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M12 4.3v2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            {/* head */}
            <rect
                x="4.75" y="6.4" width="14.5" height="11.4" rx="3"
                fill="none" stroke="currentColor" strokeWidth="1.6"
            />
            {/* ears */}
            <path d="M2.9 11v2.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M21.1 11v2.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            {/* eyes — light up and blink when the tab activates */}
            <circle
                cx="9.3" cy="11.3" r="1.35"
                fill={active ? "currentColor" : "none"}
                fillOpacity={active ? 0.9 : 0}
                stroke="currentColor" strokeWidth="1.4"
                className={active ? "dock-anim dock-blink" : undefined}
            />
            <circle
                cx="14.7" cy="11.3" r="1.35"
                fill={active ? "currentColor" : "none"}
                fillOpacity={active ? 0.9 : 0}
                stroke="currentColor" strokeWidth="1.4"
                className={active ? "dock-anim dock-blink" : undefined}
            />
            {/* mouth */}
            <path d="M9.4 14.9h5.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}

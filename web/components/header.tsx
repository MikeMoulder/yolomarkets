import Link from "next/link";
import { WalletButton } from "./wallet-button";
import { AdminLink } from "./admin-link";
import { Logo } from "./logo";

const NAV = [
    { href: "/", label: "Markets" },
    { href: "/markets/fast", label: "Fast" },
    { href: "/portfolio", label: "Portfolio" },
    { href: "/agent", label: "Agent" },
];

export function Header() {
    return (
        <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur-md">
            <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-8 px-6">
                <Link
                    href="/"
                    className="flex items-center gap-2.5 group"
                    aria-label="yolomarkets home"
                >
                    <Logo size={22} className="text-text shrink-0" />
                    <span className="text-[16px] font-semibold tracking-tight text-text leading-none">
                        yolomarkets<span className="text-brand-dot">.</span>
                    </span>
                </Link>

                <nav className="hidden md:flex items-center gap-1">
                    {NAV.map((item) => (
                        <Link
                            key={item.href}
                            href={item.href}
                            className="px-3.5 py-1.5 text-[13px] text-text-dim hover:text-text hover:bg-bg-elev/60 rounded-full transition-all"
                        >
                            {item.label}
                        </Link>
                    ))}
                </nav>

                <div className="ml-auto flex items-center gap-3">
                    <AdminLink />
                    <WalletButton />
                </div>
            </div>
        </header>
    );
}

"use client";

/** Header link that only appears when the connected wallet is on the
 *  client-side admin whitelist (NEXT_PUBLIC_ADMIN_ADDRESSES). The link itself
 *  is just a UX affordance — the actual gate is server-side in proxy.ts +
 *  requireAdminSession(). */

import Link from "next/link";
import { useAccount } from "wagmi";
import { useEffect, useMemo, useState } from "react";

function getClientAdminWhitelist(): Set<string> {
    const raw = process.env.NEXT_PUBLIC_ADMIN_ADDRESSES ?? "";
    return new Set(
        raw
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
    );
}

export function AdminLink() {
    const { address } = useAccount();
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    const whitelist = useMemo(() => getClientAdminWhitelist(), []);
    if (!mounted || !address) return null;
    if (!whitelist.has(address.toLowerCase())) return null;

    return (
        <Link
            href="/admin"
            className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 border border-accent/35 bg-accent/[0.08] hover:bg-accent/[0.14] hover:border-accent/55 text-[11px] num uppercase tracking-[0.18em] text-accent transition-colors rounded-sm"
        >
            <span className="w-1.5 h-1.5 rounded-full bg-accent live-dot" />
            Admin
        </Link>
    );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
    const router = useRouter();
    const [busy, setBusy] = useState(false);

    async function handleLogout() {
        setBusy(true);
        await fetch("/api/admin/logout", { method: "POST" });
        router.replace("/admin/login");
        router.refresh();
    }

    return (
        <button
            onClick={handleLogout}
            disabled={busy}
            className="h-[30px] px-3 border border-border hover:border-no/40 hover:bg-no/10 text-[11px] num uppercase tracking-[0.18em] text-text-mute hover:text-no transition-colors rounded-sm disabled:opacity-50"
        >
            {busy ? "signing out…" : "sign out"}
        </button>
    );
}

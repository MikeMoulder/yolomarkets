import { Suspense } from "react";
import { LoginClient } from "./login-client";
import { getAdminSession } from "@/lib/admin-session";
import { redirect } from "next/navigation";

type Params = Promise<{ from?: string }>;

export const metadata = { title: "Admin · Login" };

export default async function AdminLoginPage({
    searchParams,
}: {
    searchParams: Params;
}) {
    const sp = await searchParams;
    // If already authenticated, skip the login screen.
    const session = await getAdminSession();
    if (session) {
        redirect(sp.from && sp.from.startsWith("/admin") ? sp.from : "/admin");
    }

    return (
        <div className="min-h-[calc(100dvh-3.5rem-2.25rem)] flex items-start justify-center px-6 py-16">
            <div className="w-full max-w-[440px]">
                <header className="mb-8">
                    <div className="flex items-baseline gap-3 mb-3">
                        <span className="section-number text-[11px] tabular">00</span>
                        <span className="text-[11px] uppercase tracking-[0.24em] text-text-mute num">
                            Restricted access
                        </span>
                    </div>
                    <h1 className="text-[28px] font-medium tracking-tight text-text leading-[1.1]">
                        Admin authentication
                    </h1>
                    <p className="mt-3 text-[13px] text-text-dim leading-[1.55] max-w-[42ch]">
                        Connect your wallet and sign an off-chain message to prove
                        ownership. Only whitelisted admin addresses are authorized to
                        manage markets, treasury allocations, and resolutions.
                    </p>
                </header>

                <div className="border border-border bg-bg-elev rounded-[2px] p-5">
                    <Suspense fallback={null}>
                        <LoginClient redirectTo={sp.from} />
                    </Suspense>
                </div>

                <ul className="mt-6 space-y-1.5 text-[11.5px] text-text-mute num leading-relaxed">
                    <li>· Signature verified server-side via viem `verifyMessage`</li>
                    <li>· One-shot nonce + 5-minute challenge cookie (replay safe)</li>
                    <li>· 1-hour HS256-signed session JWT, httpOnly</li>
                    <li>· No on-chain transaction; signature does not move funds</li>
                </ul>
            </div>
        </div>
    );
}

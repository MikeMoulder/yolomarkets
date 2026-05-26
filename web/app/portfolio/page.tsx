import { Suspense } from "react";
import { PortfolioClient } from "./portfolio-client";

export const metadata = { title: "Portfolio" };

export default function PortfolioPage() {
    return (
        <div className="mx-auto max-w-[1280px] px-6 py-10">
            <div className="text-[11px] uppercase tracking-[0.22em] text-text-mute mb-6">
                / portfolio
            </div>
            <h1 className="text-[28px] md:text-[36px] leading-[1.1] tracking-tight font-medium mb-8">
                Your positions
            </h1>
            <Suspense fallback={<div className="text-text-mute text-[13px]">loading…</div>}>
                <PortfolioClient />
            </Suspense>
        </div>
    );
}

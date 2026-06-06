import type { Metadata } from "next";
import { LegalPage } from "../legal-page";

export const metadata: Metadata = { title: "Risk Disclosure" };

export default function RiskPage() {
    return (
        <LegalPage
            eyebrow="Legal · risk"
            title="Risk disclosure"
            summary="Prediction markets and autonomous trading carry real execution risk even on testnet. This page captures the main risks users should understand before interacting with the product."
            sections={[
                {
                    heading: "Product risk",
                    body: [
                        "Market pricing, portfolio views, and agent decisions depend on smart contracts, RPC providers, index reads, and external data sources. Any of these components can fail, lag, or return stale data.",
                        "Manual resolution remains part of the current operating model. A market may stay unresolved until an authorized admin reviews the outcome and submits the resolution transaction.",
                    ],
                },
                {
                    heading: "Execution risk",
                    body: [
                        "Trades are subject to slippage, approval requirements, deadline gating, and wallet confirmation flows. A displayed preview is informative only; the final on-chain result is determined by the contract execution that lands on-chain.",
                        "Agent mode adds an additional layer of model risk. The agent can be wrong, external signals can be noisy, and the configured permission caps are the main protection against oversized behavior.",
                    ],
                },
            ]}
        />
    );
}

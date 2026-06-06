import type { Metadata } from "next";
import { LegalPage } from "../legal-page";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
    return (
        <LegalPage
            eyebrow="Legal · privacy"
            title="Privacy overview"
            summary="The current product stores only the data needed to operate testnet markets, agent profiles, and admin access. This page describes the practical data footprint of the app today."
            sections={[
                {
                    heading: "Wallet and session data",
                    body: [
                        "When you connect a wallet, the app uses your public address to read on-chain balances, positions, approvals, and smart-account state. Admin login additionally stores a short-lived signed session cookie after your off-chain signature is verified.",
                        "The app does not ask for private keys or seed phrases. Signing in or trading requires wallet signatures or transactions handled by your wallet provider.",
                    ],
                },
                {
                    heading: "Profile and operational data",
                    body: [
                        "If you configure agent settings, the app may store profile preferences, execution metadata, and decision logs in the configured database so the runner and UI can stay in sync.",
                        "Because this is still a testnet product, logged data should be treated as operational telemetry rather than a finalized production privacy model.",
                    ],
                },
            ]}
        />
    );
}

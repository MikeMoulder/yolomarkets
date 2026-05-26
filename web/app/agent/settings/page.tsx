import { SettingsClient } from "./settings-client";

export const metadata = { title: "Agent settings" };
export const dynamic = "force-dynamic";

export default function SettingsPage() {
    return <SettingsClient />;
}

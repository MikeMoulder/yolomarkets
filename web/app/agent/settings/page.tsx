import { SettingsClient } from "./settings-client";

export const metadata = { title: "Agent settings" };
// Pure client-component shell (all per-user state is read client-side), so the
// server render is fully static — no per-request function work at all.

export default function SettingsPage() {
    return <SettingsClient />;
}

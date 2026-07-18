"use client";

/**
 * TEMPORARY 155118 isolation probe — remove after diagnosis.
 *
 * Runs a PIN-setup challenge for a fresh developer-created user with a
 * server-minted matched pair. One button, result on screen, everything also
 * mirrored to the server diag file.
 */
import { useState } from "react";

type TestState =
    | { phase: "idle" }
    | { phase: "running"; note: string }
    | { phase: "done"; ok: boolean; note: string };

function beacon(line: string) {
    console.log(`[circle-diag] ${line}`);
    void fetch("/api/circle/diag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ line }),
    }).catch(() => {});
}

export default function CircleTestPage() {
    const [state, setState] = useState<TestState>({ phase: "idle" });

    async function run() {
        setState({ phase: "running", note: "creating dev user + challenge…" });
        try {
            const res = await fetch("/api/circle/test-setup", { method: "POST" });
            const setup = (await res.json()) as {
                userId?: string;
                userToken?: string;
                encryptionKey?: string;
                challengeId?: string;
                error?: string;
            };
            if (!res.ok || !setup.userToken || !setup.encryptionKey || !setup.challengeId) {
                throw new Error(setup.error ?? "test-setup failed");
            }
            beacon(`test page got setup, launching SDK PIN UI`);
            setState({ phase: "running", note: "enter a test PIN in the Circle modal…" });

            const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
            if (!appId) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID missing");
            const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
            const sdk = new W3SSdk({ appSettings: { appId } }) as unknown as {
                getDeviceId: () => Promise<string>;
                setAuthentication: (a: { userToken: string; encryptionKey: string }) => void;
                execute: (
                    id: string,
                    cb: (err: unknown, result?: { status?: string; type?: string }) => void,
                ) => void;
            };
            await sdk.getDeviceId();
            sdk.setAuthentication({
                userToken: setup.userToken,
                encryptionKey: setup.encryptionKey,
            });

            await new Promise<void>((resolve, reject) => {
                sdk.execute(setup.challengeId!, (err, result) => {
                    if (err) {
                        const e = err as { code?: unknown; message?: unknown };
                        beacon(
                            `test PIN challenge FAILED code=${String(e.code)} msg=${String(e.message)}`,
                        );
                        reject(new Error(`code=${String(e.code)} msg=${String(e.message)}`));
                        return;
                    }
                    beacon(
                        `test PIN challenge OK type=${result?.type} status=${result?.status}`,
                    );
                    resolve();
                });
            });
            setState({
                phase: "done",
                ok: true,
                note: "PIN challenge SUCCEEDED for dev-created user — problem is specific to email-OTP sessions.",
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            beacon(`test page result: FAIL ${msg}`);
            setState({
                phase: "done",
                ok: false,
                note: `FAILED: ${msg} — if this is 155118, PIN challenges are broken app-wide (Console/backend level).`,
            });
        }
    }

    return (
        <main className="mx-auto max-w-[560px] px-6 py-16 space-y-6">
            <h1 className="text-xl font-semibold">Circle PIN isolation test</h1>
            <p className="text-sm opacity-70">
                Creates a throwaway developer-created Circle user with a
                provably-matched token/key pair and runs a PIN-setup challenge.
                Enter any 6-digit test PIN (e.g. 122333) when the Circle modal
                appears.
            </p>
            <button
                onClick={run}
                disabled={state.phase === "running"}
                className="border border-current px-4 py-2 text-sm disabled:opacity-50"
            >
                {state.phase === "running" ? "Running…" : "Run PIN test"}
            </button>
            {state.phase === "running" && <p className="text-sm">{state.note}</p>}
            {state.phase === "done" && (
                <p className={`text-sm font-medium ${state.ok ? "text-green-500" : "text-red-500"}`}>
                    {state.note}
                </p>
            )}
        </main>
    );
}

"use client";

/**
 * Confirm-before-transaction dialog for Circle (custodial) wallets.
 *
 * The server signs Circle transactions without any wallet popup, so this is
 * the user's only checkpoint before funds move. `confirmCircleTx(summary)`
 * resolves true/false; "don't ask again" persists to localStorage and makes
 * future calls resolve immediately. The wallet menu can clear the flag.
 */
import {
    createContext,
    useCallback,
    useContext,
    useRef,
    useState,
    type ReactNode,
} from "react";

const SKIP_KEY = "yolo.circleConfirm.skip";

export type CircleTxSummary = {
    title: string; // e.g. "Buy YES shares"
    lines: Array<{ label: string; value: string }>;
};

type CircleConfirmContextValue = {
    confirmCircleTx: (summary: CircleTxSummary) => Promise<boolean>;
    skipConfirm: boolean;
    setSkipConfirm: (skip: boolean) => void;
};

const CircleConfirmContext = createContext<CircleConfirmContextValue | null>(null);

function readSkip(): boolean {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SKIP_KEY) === "1";
}

export function CircleConfirmProvider({ children }: { children: ReactNode }) {
    const [pending, setPending] = useState<CircleTxSummary | null>(null);
    const [neverAsk, setNeverAsk] = useState(false);
    const [skipConfirm, setSkipState] = useState(readSkip);
    const resolver = useRef<((ok: boolean) => void) | null>(null);

    const setSkipConfirm = useCallback((skip: boolean) => {
        setSkipState(skip);
        if (skip) window.localStorage.setItem(SKIP_KEY, "1");
        else window.localStorage.removeItem(SKIP_KEY);
    }, []);

    const confirmCircleTx = useCallback(
        (summary: CircleTxSummary): Promise<boolean> => {
            if (readSkip()) return Promise.resolve(true);
            return new Promise<boolean>((resolve) => {
                // Only one confirm at a time; a second request cancels the first.
                resolver.current?.(false);
                resolver.current = resolve;
                setNeverAsk(false);
                setPending(summary);
            });
        },
        [],
    );

    const settle = useCallback(
        (ok: boolean) => {
            if (ok && neverAsk) setSkipConfirm(true);
            setPending(null);
            resolver.current?.(ok);
            resolver.current = null;
        },
        [neverAsk, setSkipConfirm],
    );

    return (
        <CircleConfirmContext.Provider
            value={{ confirmCircleTx, skipConfirm, setSkipConfirm }}
        >
            {children}
            {pending && (
                <div
                    className="fixed inset-0 z-[110] grid place-items-center bg-black/68 px-4 backdrop-blur-md"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Confirm transaction"
                >
                    <div className="w-full max-w-[400px] border border-border-strong bg-bg-elev shadow-2xl shadow-black/60">
                        <div className="border-b border-border px-5 py-4">
                            <div className="text-[10px] uppercase tracking-[0.18em] text-text-mute">
                                confirm transaction
                            </div>
                            <div className="mt-1 text-[16px] font-semibold text-text">
                                {pending.title}
                            </div>
                        </div>
                        <div className="space-y-2 px-5 py-4">
                            {pending.lines.map((line) => (
                                <div
                                    key={line.label}
                                    className="flex items-center justify-between gap-3"
                                >
                                    <span className="text-[11px] uppercase tracking-[0.14em] text-text-mute">
                                        {line.label}
                                    </span>
                                    <span className="num break-all text-right text-[13px] text-text">
                                        {line.value}
                                    </span>
                                </div>
                            ))}
                            <label className="mt-2 flex cursor-pointer items-center gap-2 border border-border bg-bg px-3 py-2 text-[12px] text-text-dim">
                                <input
                                    type="checkbox"
                                    checked={neverAsk}
                                    onChange={(e) => setNeverAsk(e.target.checked)}
                                    className="accent-current"
                                />
                                Don&apos;t ask again on this device
                            </label>
                        </div>
                        <div className="flex gap-2 border-t border-border px-5 py-4">
                            <button
                                onClick={() => settle(false)}
                                className="h-10 flex-1 border border-border bg-bg text-[12px] text-text-dim transition-colors hover:border-border-bright hover:bg-bg-hover hover:text-text"
                            >
                                cancel
                            </button>
                            <button
                                onClick={() => settle(true)}
                                className="h-10 flex-1 border border-border-bright bg-bg-elev-2 text-[12px] font-semibold text-text transition-colors hover:bg-bg-hover"
                            >
                                confirm
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </CircleConfirmContext.Provider>
    );
}

export function useCircleConfirm() {
    const value = useContext(CircleConfirmContext);
    if (!value) {
        throw new Error("useCircleConfirm must be used inside CircleConfirmProvider");
    }
    return value;
}

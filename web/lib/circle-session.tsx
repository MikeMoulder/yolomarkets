"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import { type Address } from "viem";

const STORAGE_KEY = "yolo.circleWalletSession";

export type CircleWalletSession = {
    address: Address;
    circleUserId: string;
    walletId?: string | null;
    email?: string | null;
    // The authenticated email-OTP session token from login. It authorizes
    // server-side signing from the user's custodial wallet (execute-tx /
    // withdraw verify it via getCurrentUser). Expires after ~14 days, at
    // which point the user must reconnect. Sandbox/testnet bearer token —
    // acceptable to persist for the hackathon.
    userToken?: string | null;
};

type CircleWalletContextValue = {
    session: CircleWalletSession | null;
    connectCircleWallet: (session: CircleWalletSession) => void;
    disconnectCircleWallet: () => void;
};

const CircleWalletContext = createContext<CircleWalletContextValue | null>(null);

function parseSession(raw: string | null): CircleWalletSession | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<CircleWalletSession>;
        if (
            typeof parsed.address === "string" &&
            parsed.address.startsWith("0x") &&
            typeof parsed.circleUserId === "string"
        ) {
            return {
                address: parsed.address.toLowerCase() as Address,
                circleUserId: parsed.circleUserId,
                walletId: parsed.walletId ?? null,
                email: parsed.email ?? null,
                userToken: parsed.userToken ?? null,
            };
        }
    } catch {
        return null;
    }
    return null;
}

export function CircleWalletProvider({ children }: { children: ReactNode }) {
    const [session, setSession] = useState<CircleWalletSession | null>(null);

    useEffect(() => {
        setSession(parseSession(window.localStorage.getItem(STORAGE_KEY)));
    }, []);

    const connectCircleWallet = useCallback((nextSession: CircleWalletSession) => {
        const normalized = {
            ...nextSession,
            address: nextSession.address.toLowerCase() as Address,
        };
        setSession(normalized);
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    }, []);

    const disconnectCircleWallet = useCallback(() => {
        setSession(null);
        window.localStorage.removeItem(STORAGE_KEY);
    }, []);

    const value = useMemo(
        () => ({ session, connectCircleWallet, disconnectCircleWallet }),
        [connectCircleWallet, disconnectCircleWallet, session],
    );

    return (
        <CircleWalletContext.Provider value={value}>
            {children}
        </CircleWalletContext.Provider>
    );
}

export function useCircleWallet() {
    const value = useContext(CircleWalletContext);
    if (!value) {
        throw new Error("useCircleWallet must be used inside CircleWalletProvider");
    }
    return value;
}

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
    // The authenticated session from login. Circle email-OTP users are
    // Circle-managed, so we can't re-mint a userToken from circleUserId via
    // /users/token (that's only for developer-created userIds). We keep the
    // login token to authorize later transactions; it expires (~60 min), at
    // which point the user must reconnect. Sandbox/testnet bearer token —
    // acceptable to persist for the hackathon.
    userToken?: string | null;
    encryptionKey?: string | null;
    // Rotating refresh token from social/email login. Used to mint a fresh
    // { userToken, encryptionKey } pair immediately before each transaction
    // (Circle binds each encryptionKey to one userToken — reusing the login
    // key against a rotated token is what triggers error 155118). Each refresh
    // rotates this value, so we persist the newest one after every tx.
    refreshToken?: string | null;
};

type CircleWalletContextValue = {
    session: CircleWalletSession | null;
    connectCircleWallet: (session: CircleWalletSession) => void;
    // Merge a partial update into the current session (e.g. rotated tokens
    // returned by a transaction refresh) without dropping the rest.
    updateCircleSession: (patch: Partial<CircleWalletSession>) => void;
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
                encryptionKey: parsed.encryptionKey ?? null,
                refreshToken: parsed.refreshToken ?? null,
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

    const updateCircleSession = useCallback(
        (patch: Partial<CircleWalletSession>) => {
            setSession((prev) => {
                if (!prev) return prev;
                const next = { ...prev, ...patch };
                window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
                return next;
            });
        },
        [],
    );

    const disconnectCircleWallet = useCallback(() => {
        setSession(null);
        window.localStorage.removeItem(STORAGE_KEY);
    }, []);

    const value = useMemo(
        () => ({
            session,
            connectCircleWallet,
            updateCircleSession,
            disconnectCircleWallet,
        }),
        [
            connectCircleWallet,
            updateCircleSession,
            disconnectCircleWallet,
            session,
        ],
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

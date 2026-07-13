"use client";

import { type Address } from "viem";
import { useAccount } from "wagmi";
import { arcTestnet } from "@/lib/chain";
import { useCircleWallet } from "@/lib/circle-session";

export type WalletKind = "external" | "circle" | null;

export type ActiveWallet = {
    address: Address | null;
    kind: WalletKind;
    isConnected: boolean;
    /** Only meaningful for external wallets; Circle SCA wallets are Arc-native. */
    isWrongChain: boolean;
};

/**
 * Unifies the two wallet systems behind one shape so trading UI doesn't care
 * whether the user signed in via MetaMask (wagmi) or Circle email/OTP. This is
 * the "useUserAddress()" abstraction prescribed in CIRCLE_SETUP.md §9.
 *
 * An external wagmi connection takes precedence; the Circle connect flow calls
 * wagmi's disconnect(), so the two are mutually exclusive in practice.
 */
export function useActiveWallet(): ActiveWallet {
    const { address, chainId, isConnected } = useAccount();
    const { session } = useCircleWallet();

    if (isConnected && address) {
        return {
            address,
            kind: "external",
            isConnected: true,
            isWrongChain: chainId !== arcTestnet.id,
        };
    }

    if (session?.address) {
        return {
            address: session.address,
            kind: "circle",
            isConnected: true,
            isWrongChain: false,
        };
    }

    return { address: null, kind: null, isConnected: false, isWrongChain: false };
}

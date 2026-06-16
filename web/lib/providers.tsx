"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "./wagmi";
import { CircleWalletProvider } from "./circle-session";

export function Providers({ children }: { children: ReactNode }) {
    const [qc] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: {
                        staleTime: 30_000,
                        refetchOnWindowFocus: false,
                    },
                },
            }),
    );
    return (
        <WagmiProvider config={wagmiConfig}>
            <QueryClientProvider client={qc}>
                <CircleWalletProvider>{children}</CircleWalletProvider>
            </QueryClientProvider>
        </WagmiProvider>
    );
}

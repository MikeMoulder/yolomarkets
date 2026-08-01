import { createConfig, fallback, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { arcTestnet } from "./chain";

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

// The chain's canonical node — `rpc.testnet.arc.network`, i.e. what a bare
// `http()` resolves to via `arcTestnet.rpcUrls.default` — answers preflights
// with NO `Access-Control-Allow-Origin` header, so every browser JSON-RPC call
// from a deployed origin is killed by CORS (balances read as undefined,
// `useWaitForTransactionReceipt` never settles, the admin panel is unusable).
// The other three Arc endpoints do send CORS headers, so the browser gets an
// explicit list. Server-side callers are unaffected and keep using
// `ARC_TESTNET_RPC_URLS` / the chain default (see lib/markets.ts).
const DEFAULT_BROWSER_RPC_URLS = [
    "https://rpc.quicknode.testnet.arc.network",
    "https://rpc.blockdaemon.testnet.arc.network",
    "https://arc-testnet.drpc.org",
];

// NEXT_PUBLIC_* is inlined at build time, so this must stay a static reference.
const browserRpcUrls = (process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

const rpcUrls = browserRpcUrls.length ? browserRpcUrls : DEFAULT_BROWSER_RPC_URLS;

export const wagmiConfig = createConfig({
    chains: [arcTestnet],
    connectors: [
        injected({ shimDisconnect: true }),
        ...(walletConnectProjectId
            ? [
                walletConnect({
                    projectId: walletConnectProjectId,
                    showQrModal: true,
                    metadata: {
                        name: "YOLO Markets",
                        description: "Trade YOLO Markets on Arc Testnet.",
                        url: appUrl,
                        icons: [`${appUrl}/icon.svg`],
                    },
                }),
            ]
            : []),
    ],
    transports: {
        [arcTestnet.id]: fallback(rpcUrls.map((url) => http(url))),
    },
    ssr: true,
});

declare module "wagmi" {
    interface Register {
        config: typeof wagmiConfig;
    }
}

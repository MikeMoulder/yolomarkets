import { createConfig, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { arcTestnet } from "./chain";

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

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
        [arcTestnet.id]: http(),
    },
    ssr: true,
});

declare module "wagmi" {
    interface Register {
        config: typeof wagmiConfig;
    }
}

import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "./chain";

export const wagmiConfig = createConfig({
    chains: [arcTestnet],
    connectors: [injected({ shimDisconnect: true })],
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

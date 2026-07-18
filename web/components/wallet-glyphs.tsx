import Image from "next/image";

/** Shared wallet iconography used by the connect modal, the header button and
 *  the connected-wallet dropdown. Kept in its own module so the modal (global
 *  provider) and the button don't have to import each other. */
export function WalletGlyph({
    kind,
    size = "md",
}: {
    kind: string;
    size?: "sm" | "md" | "lg";
}) {
    const normalized = kind.toLowerCase();
    if (normalized.includes("circle")) {
        return <WalletImage src="/circle-icon.png" alt="" size={size} />;
    }
    if (normalized.includes("coinbase")) {
        return <WalletImage src="/coinbase.png" alt="" size={size} />;
    }
    if (normalized.includes("rabby")) {
        return <WalletImage src="/rabby.png" alt="" size={size} />;
    }
    if (normalized.includes("keplr")) {
        return <WalletImage src="/Keplr.png" alt="" size={size} />;
    }
    if (normalized.includes("okx")) {
        return <WalletImage src="/OKX.png" alt="" size={size} />;
    }
    if (normalized.includes("phantom")) {
        return <WalletImage src="/Phantom.png" alt="" size={size} />;
    }
    if (normalized.includes("injected") || normalized.includes("metamask")) {
        return <WalletImage src="/metamask.svg" alt="" size={size} />;
    }
    return <GenericWalletGlyph size={size} />;
}

function WalletImage({
    src,
    alt,
    size,
}: {
    src: string;
    alt: string;
    size: "sm" | "md" | "lg";
}) {
    const className =
        size === "lg"
            ? "h-[25px] w-[25px] object-contain"
            : size === "sm"
                ? "h-[12.24px] w-[12.24px] object-contain"
                : "h-5 w-5 object-contain";
    return (
        <Image
            src={src}
            alt={alt}
            width={25}
            height={25}
            className={className}
            draggable={false}
        />
    );
}

function GenericWalletGlyph({ size }: { size: "sm" | "md" | "lg" }) {
    const className =
        size === "lg"
            ? "h-[25px] w-[25px] text-text-dim"
            : size === "sm"
                ? "h-[12.24px] w-[12.24px] text-text-dim"
                : "h-5 w-5 text-text-dim";
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
            <path
                d="M5 8h13.5a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 18.5 17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h12M16 12.5h.1"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
            />
        </svg>
    );
}

export function ArrowGlyph() {
    return (
        <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="h-4 w-4 text-text-faint transition-colors group-hover:text-text-dim"
        >
            <path
                d="M9 6l6 6-6 6"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
            />
        </svg>
    );
}

export function CloseGlyph() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
            <path
                d="m7 7 10 10M17 7 7 17"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2"
            />
        </svg>
    );
}

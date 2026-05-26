type Props = {
    size?: number;
    className?: string;
};

/**
 * Polygonal mark — an angular shield split by a forking notch, evoking the
 * binary YES/NO branch at the heart of every prediction market. Stroked,
 * never filled, so it reads as a wire-frame symbol against the dark canvas.
 */
export function Logo({ size = 22, className = "" }: Props) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 32 32"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="miter"
            strokeLinecap="square"
            className={className}
            aria-hidden="true"
        >
            {/* Outer angular shield — irregular hexagon */}
            <path d="M16 2 L28 8 L28 22 L16 30 L4 22 L4 8 Z" />
            {/* Inner forking notch — the YES/NO branch */}
            <path d="M16 9 L21 14 L21 22 M16 9 L11 14 L11 22 M16 9 L16 16" />
            {/* Asymmetric accent — top-right shard */}
            <path d="M24 6 L28 8 L26 12" />
        </svg>
    );
}

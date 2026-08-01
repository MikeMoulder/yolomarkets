"use client";

/**
 * Share control for a market or a position.
 *
 * Opens a small panel with a live preview of the generated ticket
 * (/api/markets/<addr>/share) plus the four things people actually do with it:
 * copy the link, save the image, post it, or hand it to the OS share sheet.
 *
 * The preview is the point — you see exactly what will be posted before you
 * post it, and it doubles as confirmation that the card rendered.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
    address: string;
    question: string;
    /** Present → the ticket renders that wallet's position instead of the market. */
    user?: string | null;
    side?: "yes" | "no" | null;
    /** Compact icon-only trigger, for dense rows. */
    compact?: boolean;
    className?: string;
};

function buildImagePath(address: string, user?: string | null, side?: "yes" | "no" | null): string {
    const qs = new URLSearchParams();
    if (user) qs.set("user", user);
    if (side) qs.set("side", side);
    const q = qs.toString();
    return `/api/markets/${address}/share${q ? `?${q}` : ""}`;
}

export function ShareButton({ address, question, user, side, compact, className }: Props) {
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const [imageCopied, setImageCopied] = useState(false);
    const [copyFailed, setCopyFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [canNativeShare, setCanNativeShare] = useState(false);
    const [canCopyImage, setCanCopyImage] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    const isBet = !!user;
    const imagePath = buildImagePath(address, user, side);

    useEffect(() => {
        setCanNativeShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
        // Writing an image to the clipboard needs the async Clipboard API plus
        // ClipboardItem. Feature-detect rather than offering an action that
        // throws — Firefox only gained PNG clipboard writes recently, and it's
        // unavailable entirely on non-secure origins.
        setCanCopyImage(
            typeof window !== "undefined" &&
                typeof ClipboardItem !== "undefined" &&
                typeof navigator?.clipboard?.write === "function",
        );
    }, []);

    // Close on outside click / Escape — the panel sits over card content.
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const pageUrl = typeof window === "undefined" ? "" : `${window.location.origin}/markets/${address}`;

    // Rows are wrapped in a <Link>; without this the trigger navigates instead.
    const stop = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const copyLink = useCallback(
        async (e: React.MouseEvent) => {
            stop(e);
            try {
                await navigator.clipboard.writeText(pageUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
            } catch {
                setCopied(false);
            }
        },
        [pageUrl],
    );

    const copyImage = useCallback(
        async (e: React.MouseEvent) => {
            stop(e);
            setCopyFailed(false);
            try {
                // Hand ClipboardItem the *promise*, don't await the blob first:
                // Safari treats the write as losing user activation across an
                // await and rejects it. Chrome and Firefox accept a promise too,
                // so this is the portable form.
                const item = new ClipboardItem({
                    "image/png": fetch(imagePath).then((r) => r.blob()),
                });
                await navigator.clipboard.write([item]);
                setImageCopied(true);
                setTimeout(() => setImageCopied(false), 1600);
            } catch {
                // Blocked by permissions, or the browser refused the type.
                setCopyFailed(true);
                setTimeout(() => setCopyFailed(false), 2200);
            }
        },
        [imagePath],
    );

    const download = useCallback(
        async (e: React.MouseEvent) => {
            stop(e);
            setBusy(true);
            try {
                const res = await fetch(imagePath);
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `yolomarkets-${isBet ? "position" : "market"}-${address.slice(0, 8)}.png`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } finally {
                setBusy(false);
            }
        },
        [imagePath, address, isBet],
    );

    const postToX = useCallback(
        (e: React.MouseEvent) => {
            stop(e);
            // X pulls the card from the page's og:image, so the link is enough —
            // no upload needed.
            const text = isBet
                ? `My ${side ? side.toUpperCase() : ""} position on: ${question}`.replace(/\s+/g, " ").trim()
                : question;
            const url = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pageUrl)}`;
            window.open(url, "_blank", "noopener,noreferrer");
        },
        [isBet, side, question, pageUrl],
    );

    const nativeShare = useCallback(
        async (e: React.MouseEvent) => {
            stop(e);
            setBusy(true);
            try {
                // Try to hand over the actual PNG so the OS sheet shows the
                // ticket; fall back to a plain link share when files aren't
                // supported (desktop Safari, most Android browsers).
                const res = await fetch(imagePath);
                const blob = await res.blob();
                const file = new File([blob], "yolomarkets.png", { type: "image/png" });
                if (navigator.canShare?.({ files: [file] })) {
                    await navigator.share({ title: question, text: question, files: [file] });
                } else {
                    await navigator.share({ title: question, text: question, url: pageUrl });
                }
            } catch {
                // User dismissed the sheet, or share was rejected — nothing to do.
            } finally {
                setBusy(false);
            }
        },
        [imagePath, question, pageUrl],
    );

    return (
        <div ref={rootRef} className={`relative ${className ?? ""}`}>
            <button
                type="button"
                onClick={(e) => {
                    stop(e);
                    setOpen((v) => !v);
                }}
                aria-label="Share"
                aria-expanded={open}
                className={
                    compact
                        ? "flex items-center justify-center w-8 h-8 rounded-lg border border-border text-text-mute hover:text-text hover:border-border-strong transition-colors"
                        : "flex items-center gap-2 px-3.5 py-2 rounded-xl border border-border text-[12px] text-text-dim hover:text-text hover:border-border-strong transition-colors"
                }
            >
                <ShareIcon />
                {!compact && <span>Share</span>}
            </button>

            {open && (
                <div
                    onClick={stop}
                    className="absolute right-0 z-50 mt-2 w-[300px] rounded-2xl border border-border-strong bg-bg-elev shadow-2xl overflow-hidden"
                >
                    {/* Preview — 1200×630, so the 16:8.4 box matches exactly. */}
                    <div className="relative bg-bg-elev-2 border-b border-border" style={{ aspectRatio: "1200 / 630" }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src={imagePath}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="absolute inset-0 w-full h-full object-cover"
                        />
                    </div>

                    <div className="p-2 flex flex-col">
                        <MenuItem onClick={copyLink} label={copied ? "Link copied" : "Copy link"} active={copied} />
                        {canCopyImage && (
                            <MenuItem
                                onClick={copyImage}
                                label={imageCopied ? "Image copied" : copyFailed ? "Copy blocked — save instead" : "Copy image"}
                                active={imageCopied}
                                muted={copyFailed}
                            />
                        )}
                        <MenuItem onClick={download} label={busy ? "Working…" : "Save image"} />
                        <MenuItem onClick={postToX} label="Post on X" />
                        {canNativeShare && <MenuItem onClick={nativeShare} label="Share…" />}
                    </div>
                </div>
            )}
        </div>
    );
}

function MenuItem({
    onClick,
    label,
    active,
    muted,
}: {
    onClick: (e: React.MouseEvent) => void;
    label: string;
    active?: boolean;
    muted?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`text-left px-3 py-2 rounded-lg text-[12.5px] transition-colors ${
                active
                    ? "text-yes"
                    : muted
                      ? "text-text-mute"
                      : "text-text-dim hover:text-text hover:bg-bg-hover"
            }`}
        >
            {label}
        </button>
    );
}

function ShareIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
            <polyline points="16 6 12 2 8 6" />
            <line x1="12" y1="2" x2="12" y2="15" />
        </svg>
    );
}

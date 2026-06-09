import type { MarketSummary } from "./markets";

const SYMBOL_RE = /\b(BTC|ETH|SOL)\b/i;
const FAST_MARKET_IMAGES: { re: RegExp; src: string }[] = [
    { re: /\b(BTC|Bitcoin)\b/i, src: "/btc-logo.png" },
    { re: /\b(ETH|Ethereum)\b/i, src: "/ethereum-logo.png" },
    { re: /\b(SOL|Solana)\b/i, src: "/solana-logo.png" },
];
const TIMEFRAME_RE = /\b(15\s?m(in)?|1\s?h(our)?)\b/i;
const DIRECTION_RE = /\b(up|down|higher|lower|above|below)\b/i;
const FAST_CATEGORY_RE = /^(fast|turbo|speed)$/i;

export function matchesFastMarket(m: MarketSummary): boolean {
    if (FAST_CATEGORY_RE.test(m.category.trim())) return true;

    const q = m.question;
    return SYMBOL_RE.test(q) && TIMEFRAME_RE.test(q) && DIRECTION_RE.test(q);
}

export function isFastMarket(m: MarketSummary): boolean {
    if (m.resolved) return false;
    return matchesFastMarket(m);
}

export function sortFastMarketsByDeadline(list: MarketSummary[]): MarketSummary[] {
    return [...list].sort((a, b) => Number(a.deadline - b.deadline));
}

export function getFastMarketImage(question: string): string | null {
    return FAST_MARKET_IMAGES.find((asset) => asset.re.test(question))?.src ?? null;
}

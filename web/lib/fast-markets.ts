import type { MarketSummary } from "./markets";

const SYMBOL_RE = /\b(BTC|ETH|SOL)\b/i;
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

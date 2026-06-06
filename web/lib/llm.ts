// Server-only OpenRouter client. Mirrors the Python POC in agent/estimate.py.

import "server-only";

const SYSTEM = `You are a calibrated prediction-market copilot.
Output STRICT JSON only - no prose before or after. Reason from first principles,
but use the supplied market context as evidence when it is available. Do not
blindly anchor to the market price. When uncertain, lower confidence and reduce
position size, but still choose a side. Your output is consumed programmatically; any
deviation from the schema breaks it.`;

const USER_TEMPLATE = (args: {
    question: string;
    criteria: string;
    deadline: string;
    marketPrice: string;
    context?: string;
}) => `MARKET: "${args.question}"
RESOLUTION CRITERIA: ${args.criteria || "(none provided)"}
RESOLVES: ${args.deadline || "(unknown)"}

CROWD SIGNAL:
  Current market YES price: ${args.marketPrice}%

${args.context ? `MARKET CONTEXT:\n${args.context}\n\n` : ""}ACTION RULES:
  - Recommend buy_yes only when your probability is meaningfully above the
    market YES price after fees/slippage.
  - Recommend buy_no only when your probability is meaningfully below the
    market YES price after fees/slippage.
  - For fast crypto markets, never overstate certainty. If live price context
        is unavailable, set low confidence and prefer smaller size.
    - Keep tips actionable: what to buy/sell, position sizing, and what
    signal would invalidate the trade.

OUTPUT FORMAT (strict JSON, no markdown fences):
{
  "probability": 0.0,
  "confidence": 0.0,
    "action": "buy_yes" | "buy_no",
    "action_label": "Buy YES" | "Buy NO",
  "action_summary": "one sentence telling the user what to do and why",
  "suggested_size": "none" | "small" | "medium",
  "actionable_tips": ["specific next step", "risk control or exit note"],
  "reasoning": "3 to 5 sentences shown to the user",
  "key_sources": ["url1", "url2"],
  "watch_for": ["signal that would change this estimate", "another"],
  "time_sensitivity": "low" | "medium" | "high"
}`;

export type EstimateAction = "buy_yes" | "buy_no";
export type SuggestedSize = "none" | "small" | "medium";

export type Estimate = {
    probability: number;
    confidence: number;
    action: EstimateAction;
    action_label: string;
    action_summary: string;
    suggested_size: SuggestedSize;
    actionable_tips: string[];
    reasoning: string;
    key_sources: string[];
    watch_for: string[];
    time_sensitivity: "low" | "medium" | "high";
};

export async function estimate(args: {
    question: string;
    criteria: string;
    deadline: string;
    marketProb: number; // 0..1
    context?: string;
}): Promise<Estimate | null> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;

    const base = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
    const model = process.env.OPENROUTER_MODEL ?? "perplexity/sonar";

    const body = {
        model,
        max_tokens: 1200,
        messages: [
            { role: "system", content: SYSTEM },
            {
                role: "user",
                content: USER_TEMPLATE({
                    question: args.question,
                    criteria: args.criteria,
                    deadline: args.deadline,
                    marketPrice: (args.marketProb * 100).toFixed(2),
                    context: args.context,
                }),
            },
        ],
    };

    try {
        const r = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "HTTP-Referer": "https://github.com/yolo-markets",
                "X-Title": "YOLO Markets web",
            },
            body: JSON.stringify(body),
            // Server-render-time cache so multiple page hits don't re-bill us.
            next: { revalidate: 300 },
        });
        if (!r.ok) return null;
        const json = await r.json();
        const message = json?.choices?.[0]?.message;
        const text = message?.content;
        if (typeof text !== "string") return null;
        const stripped = text
            .trim()
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/```$/i, "")
            .trim();
        const parsed = normalizeEstimate(JSON.parse(stripped), args.marketProb);
        if (!parsed) return null;

        // Perplexity/online-enabled models return the URLs they actually
        // browsed in a separate field. Merge them so the user sees live
        // citations, not whatever the model imagined for `key_sources`.
        const liveCitations: string[] = [
            ...(Array.isArray(json?.citations) ? (json.citations as unknown[]) : []),
            ...(Array.isArray(message?.annotations)
                ? (message.annotations as Array<{ url?: string; url_citation?: { url?: string } }>)
                      .map((a) => a?.url ?? a?.url_citation?.url)
                : []),
        ].filter((u): u is string => typeof u === "string" && u.length > 0);

        if (liveCitations.length > 0) {
            const merged = new Set<string>([...liveCitations, ...(parsed.key_sources ?? [])]);
            parsed.key_sources = Array.from(merged);
        }

        return parsed;
    } catch {
        return null;
    }
}

function normalizeEstimate(raw: unknown, marketProb: number): Estimate | null {
    if (!raw || typeof raw !== "object") return null;
    const payload = raw as Partial<Estimate>;

    const probability = clamp01(Number(payload.probability));
    const confidence = clamp01(Number(payload.confidence));
    if (probability === null || confidence === null) return null;

    const edge = probability - marketProb;
    const fallbackAction: EstimateAction = edge >= 0 ? "buy_yes" : "buy_no";

    const action = isAction(payload.action) ? payload.action : fallbackAction;
    const action_label =
        typeof payload.action_label === "string" && payload.action_label.trim()
            ? payload.action_label.trim()
            : action === "buy_yes"
              ? "Buy YES"
                            : "Buy NO";

    const suggested_size = isSuggestedSize(payload.suggested_size)
        ? payload.suggested_size
                : confidence < 0.45
          ? "none"
          : confidence > 0.7 && Math.abs(edge) > 0.08
            ? "medium"
            : "small";

    return {
        probability,
        confidence,
        action,
        action_label,
        action_summary: cleanString(payload.action_summary) || fallbackActionSummary(action, edge),
        suggested_size,
        actionable_tips: cleanStringArray(payload.actionable_tips),
        reasoning: cleanString(payload.reasoning),
        key_sources: cleanStringArray(payload.key_sources),
        watch_for: cleanStringArray(payload.watch_for),
        time_sensitivity:
            payload.time_sensitivity === "low" ||
            payload.time_sensitivity === "medium" ||
            payload.time_sensitivity === "high"
                ? payload.time_sensitivity
                : "medium",
    };
}

function clamp01(value: number): number | null {
    if (!Number.isFinite(value)) return null;
    return Math.min(1, Math.max(0, value));
}

function cleanString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function cleanStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 6);
}

function isAction(value: unknown): value is EstimateAction {
    return value === "buy_yes" || value === "buy_no";
}

function isSuggestedSize(value: unknown): value is SuggestedSize {
    return value === "none" || value === "small" || value === "medium";
}

function fallbackActionSummary(action: EstimateAction, edge: number): string {
    const edgePts = Math.abs(edge * 100).toFixed(1);
    if (action === "buy_yes") {
        return `Buy YES only if execution stays near the displayed price; estimated edge is about ${edgePts} points.`;
    }
    return `Buy NO only if execution stays near the displayed price; estimated edge is about ${edgePts} points.`;
}

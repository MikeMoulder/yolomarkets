// Server-only OpenRouter client. Mirrors the Python POC in agent/estimate.py.

import "server-only";

const SYSTEM = `You are a calibrated probability estimator for prediction markets.
Output STRICT JSON only — no prose before or after. Reason from first principles;
do NOT anchor to the market price. When uncertain, lower your confidence score.
Your output is consumed programmatically; any deviation from the schema breaks it.`;

const USER_TEMPLATE = (args: {
    question: string;
    criteria: string;
    deadline: string;
    marketPrice: string;
}) => `MARKET: "${args.question}"
RESOLUTION CRITERIA: ${args.criteria || "(none provided)"}
RESOLVES: ${args.deadline || "(unknown)"}

CROWD SIGNAL:
  Current market YES price: ${args.marketPrice}%

OUTPUT FORMAT (strict JSON, no markdown fences):
{
  "probability": 0.0,
  "confidence": 0.0,
  "reasoning": "3 to 5 sentences shown to the user",
  "key_sources": ["url1", "url2"],
  "watch_for": ["signal that would change this estimate", "another"],
  "time_sensitivity": "low" | "medium" | "high"
}`;

export type Estimate = {
    probability: number;
    confidence: number;
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
}): Promise<Estimate | null> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;

    const base = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
    const model = process.env.OPENROUTER_MODEL ?? "perplexity/sonar";

    const body = {
        model,
        max_tokens: 1024,
        messages: [
            { role: "system", content: SYSTEM },
            {
                role: "user",
                content: USER_TEMPLATE({
                    question: args.question,
                    criteria: args.criteria,
                    deadline: args.deadline,
                    marketPrice: (args.marketProb * 100).toFixed(2),
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
            // Server-render-time cache so multiple page hits don't re-bill us
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
        const parsed = JSON.parse(stripped) as Estimate;

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

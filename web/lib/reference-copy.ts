export function sanitizeReferenceCopy(text: string): string {
    return text
        .replace(/Polymarket's/gi, "the reference market's")
        .replace(/Polymarket/gi, "the reference market");
}

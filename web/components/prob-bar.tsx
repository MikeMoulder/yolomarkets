/** Horizontal probability bar with a single thin tick at p. */
export function ProbBar({ p }: { p: number }) {
    const pct = Math.max(0, Math.min(1, p)) * 100;
    return (
        <div className="prob-bar">
            <div className="yes-fill" style={{ width: `${pct}%` }} />
            <div className="tick" style={{ left: `${pct}%` }} />
        </div>
    );
}

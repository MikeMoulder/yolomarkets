/**
 * TEMPORARY: POST { line } → appends to the server diag file so client-side
 * Circle SDK failures are readable without scraping the browser console.
 * Remove together with lib/circle-diag.ts once 155118 is fixed.
 */
import { NextResponse, type NextRequest } from "next/server";
import { appendServerDiag } from "@/lib/circle-diag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    let body: { line?: string };
    try {
        body = await req.json();
    } catch {
        body = {};
    }
    if (typeof body.line === "string" && body.line.length <= 600) {
        appendServerDiag(`[browser] ${body.line}`);
    }
    return NextResponse.json({ ok: true });
}

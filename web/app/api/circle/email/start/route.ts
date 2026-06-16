/**
 * Starts Circle-native email OTP login.
 *
 * The browser first calls W3SSdk.getDeviceId(), then sends that deviceId
 * here. Circle sends the OTP email and returns device credentials that the
 * browser passes back into W3SSdk.verifyOtp().
 */
import { NextResponse, type NextRequest } from "next/server";
import { createEmailOtpToken } from "@/lib/circle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
    email?: string;
    deviceId?: string;
};

function normalizeEmail(email: string | undefined) {
    const trimmed = email?.trim().toLowerCase();
    return trimmed || null;
}

export async function POST(req: NextRequest) {
    let body: Body;
    try {
        body = (await req.json()) as Body;
    } catch {
        body = {};
    }

    const email = normalizeEmail(body.email);
    if (!email || !body.deviceId) {
        return NextResponse.json(
            { error: "email and deviceId required" },
            { status: 400 },
        );
    }

    try {
        const token = await createEmailOtpToken({
            email,
            deviceId: body.deviceId,
        });
        return NextResponse.json({ email, ...token });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const missingSmtp =
            msg.includes("155150") ||
            msg.toLowerCase().includes("smtp server configuration is not found");
        const needsSetup =
            missingSmtp ||
            msg.includes("CIRCLE_API_KEY") ||
            msg.includes("CIRCLE_ENTITY_SECRET") ||
            msg.includes("see CIRCLE_SETUP.md");
        return NextResponse.json(
            {
                error: missingSmtp
                    ? "Circle email OTP needs SMTP configured in Developer Console."
                    : needsSetup
                    ? "Circle not configured — see CIRCLE_SETUP.md"
                    : "Circle email OTP failed",
                detail: msg.slice(0, 400),
                missingSmtp,
                needsSetup,
            },
            { status: 503 },
        );
    }
}

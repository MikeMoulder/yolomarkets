/**
 * Next.js 16 Proxy (formerly Middleware).
 *
 * This is intentionally minimal — it only does the optimistic check that the
 * admin session cookie is *present*. Real session verification happens
 * inside each protected `/admin/*` page server component via
 * `requireAdminSession()` so we never trust the cookie alone.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE } from "@/lib/admin-auth";

export const config = {
    matcher: ["/admin/:path*"],
};

export function proxy(req: NextRequest) {
    const { pathname } = req.nextUrl;

    // The login + verify routes must remain reachable when logged out.
    if (pathname === "/admin/login" || pathname.startsWith("/api/admin/")) {
        return NextResponse.next();
    }

    const has = req.cookies.has(ADMIN_SESSION_COOKIE);
    if (!has) {
        const url = req.nextUrl.clone();
        url.pathname = "/admin/login";
        url.searchParams.set("from", pathname);
        return NextResponse.redirect(url);
    }

    return NextResponse.next();
}

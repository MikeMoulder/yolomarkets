/** Server-side session helpers. Used by protected admin pages to verify the
 *  current request belongs to a whitelisted admin. */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
    ADMIN_SESSION_COOKIE,
    type SessionPayload,
    verifyAdminSessionJwt,
} from "./admin-auth";

export async function getAdminSession(): Promise<SessionPayload | null> {
    const jar = await cookies();
    const token = jar.get(ADMIN_SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifyAdminSessionJwt(token);
}

export async function requireAdminSession(from?: string): Promise<SessionPayload> {
    const session = await getAdminSession();
    if (!session) {
        redirect(from ? `/admin/login?from=${encodeURIComponent(from)}` : "/admin/login");
    }
    return session;
}

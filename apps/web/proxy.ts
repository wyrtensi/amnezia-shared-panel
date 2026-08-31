import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, publicBaseUrl, verifySession } from "@/lib/session";

/**
 * Gate page navigations. Two ways in:
 *   1. Behind Cloudflare Access — the edge injects `cf-access-jwt-assertion`;
 *      the control-api verifies it. Allow through.
 *   2. Direct (server-side Google login) — a valid `panel_session` cookie.
 * Anything else is redirected to /login. API routes are excluded (they return
 * 401/JSON from the control-api instead of an HTML redirect).
 */
export async function proxy(request: NextRequest) {
  // Direct login is off unless a shared secret is configured. When off, don't
  // gate at all — Cloudflare Access (edge) and the control-api handle auth, so a
  // CF-only deployment is completely unaffected by this middleware.
  if (!process.env.PANEL_IDENTITY_SECRET) {
    return NextResponse.next();
  }
  if (request.headers.get("cf-access-jwt-assertion")) {
    return NextResponse.next();
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySession(token)) {
    return NextResponse.next();
  }
  return NextResponse.redirect(
    new URL("/login", publicBaseUrl(request.nextUrl.origin)),
  );
}

export const config = {
  matcher: [
    // Everything except: /login, /api/*, Next internals, and files with an
    // extension (static assets).
    "/((?!login|api|_next/static|_next/image|favicon.ico|.*\\.).*)",
  ],
};

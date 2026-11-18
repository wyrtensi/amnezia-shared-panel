import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { buildAuthorizeUrl, googleConfig } from "@/lib/google-oauth";
import {
  STATE_COOKIE,
  domainScopedCookieOptions,
  encodeOAuthState,
  publicBaseUrl,
} from "@/lib/session";

export function GET(request?: NextRequest) {
  const cfg = googleConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: "GOOGLE_LOGIN_NOT_CONFIGURED" },
      { status: 501 },
    );
  }
  const returnOrigin = request
    ? publicBaseUrl(request.nextUrl.origin, request.headers)
    : undefined;
  const state = encodeOAuthState(randomBytes(16).toString("hex"), returnOrigin);
  const res = NextResponse.redirect(buildAuthorizeUrl(cfg, state));
  // Short-lived CSRF state, checked in the callback.
  res.cookies.set(
    STATE_COOKIE,
    state,
    domainScopedCookieOptions({
      httpOnly: true,
      secure: true,
      sameSite: "lax" as const,
      path: "/",
      maxAge: 600,
    }),
  );
  return res;
}

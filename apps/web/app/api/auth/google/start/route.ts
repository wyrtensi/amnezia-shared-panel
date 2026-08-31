import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { buildAuthorizeUrl, googleConfig } from "@/lib/google-oauth";
import { STATE_COOKIE } from "@/lib/session";

export function GET() {
  const cfg = googleConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: "GOOGLE_LOGIN_NOT_CONFIGURED" },
      { status: 501 },
    );
  }
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(buildAuthorizeUrl(cfg, state));
  // Short-lived CSRF state, checked in the callback.
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}

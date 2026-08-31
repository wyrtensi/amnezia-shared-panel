import { NextResponse, type NextRequest } from "next/server";
import { exchangeCodeForIdentity, googleConfig } from "@/lib/google-oauth";
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  sessionCookieOptions,
  signSession,
} from "@/lib/session";

export async function GET(request: NextRequest) {
  const cfg = googleConfig();
  const url = request.nextUrl;
  const loginUrl = new URL("/login", url.origin);
  if (!cfg) {
    return NextResponse.json(
      { error: "GOOGLE_LOGIN_NOT_CONFIGURED" },
      { status: 501 },
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = request.cookies.get(STATE_COOKIE)?.value;
  if (!code || !state || !expectedState || state !== expectedState) {
    loginUrl.searchParams.set("error", "state");
    return NextResponse.redirect(loginUrl);
  }

  const identity = await exchangeCodeForIdentity(cfg, code);
  if (!identity) {
    loginUrl.searchParams.set("error", "google");
    return NextResponse.redirect(loginUrl);
  }

  const token = await signSession({
    email: identity.email,
    sub: identity.sub,
    provider: "google",
  });

  // Validate against the panel allowlist BEFORE granting a session: resolveIdentity
  // rejects an unknown email that is not on an allowed domain, pre-created, or a
  // bootstrap admin (403). Only set the cookie if the API accepts the identity.
  const apiBase = (process.env.CONTROL_API_URL ?? "http://127.0.0.1:3001").replace(
    /\/$/,
    "",
  );
  let allowed = false;
  try {
    const check = await fetch(`${apiBase}/api/me`, {
      headers: { "x-panel-identity": token, accept: "application/json" },
      cache: "no-store",
    });
    allowed = check.ok;
  } catch {
    loginUrl.searchParams.set("error", "unavailable");
    return NextResponse.redirect(loginUrl);
  }
  if (!allowed) {
    loginUrl.searchParams.set("error", "not_allowed");
    return NextResponse.redirect(loginUrl);
  }

  const res = NextResponse.redirect(new URL("/", url.origin));
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
  res.cookies.delete(STATE_COOKIE);
  return res;
}

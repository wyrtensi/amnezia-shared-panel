import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  publicBaseUrl,
  sharedParentDomain,
} from "@/lib/session";

const logout = (request: NextRequest) => {
  // 303 so a form POST redirects to /login as a GET (not a re-POSTed 307).
  const res = NextResponse.redirect(
    new URL("/login", publicBaseUrl(request.nextUrl.origin, request.headers)),
    303,
  );
  const parent = sharedParentDomain();
  if (parent) {
    res.cookies.set(SESSION_COOKIE, "", { path: "/", domain: parent, maxAge: 0 });
  }
  res.cookies.delete(SESSION_COOKIE);
  return res;
};

export const POST = logout;
export const GET = logout;

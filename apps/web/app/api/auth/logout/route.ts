import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, publicBaseUrl } from "@/lib/session";

const logout = (request: NextRequest) => {
  const res = NextResponse.redirect(
    new URL("/login", publicBaseUrl(request.nextUrl.origin)),
  );
  res.cookies.delete(SESSION_COOKIE);
  return res;
};

export const POST = logout;
export const GET = logout;

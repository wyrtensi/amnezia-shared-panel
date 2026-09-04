import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";
import {
  buildControlTarget,
  relayedContentSecurityPolicy,
  relayedContentType,
} from "@/lib/control-proxy";

// This route is reachable without the page middleware (apps/web/proxy.ts
// excludes /api), and it forwards the caller's session as the API bearer
// token. The target URL must therefore be built defensively — see
// lib/control-proxy.ts for why a catch-all segment can smuggle a whole URL.
const proxy = async (request: NextRequest, context: { params: Promise<{ path: string[] }> }) => {
  const { path } = await context.params;
  const baseUrl = process.env.CONTROL_API_URL ?? "http://127.0.0.1:3001";
  const target = buildControlTarget(baseUrl, path, request.nextUrl.search);
  if (!target) {
    return Response.json(
      { error: "INVALID_PROXY_PATH", message: "Path must stay on the control API" },
      { status: 400 },
    );
  }
  const headers = new Headers();
  headers.set("accept", request.headers.get("accept") ?? "application/json");
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accessJwt = request.headers.get("cf-access-jwt-assertion");
  if (accessJwt) headers.set("cf-access-jwt-assertion", accessJwt);
  // Direct (server-side Google) login: forward the signed session as the
  // identity token the control-api verifies. The session token IS that token.
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (session) headers.set("x-panel-identity", session);
  if (process.env.DEV_IDENTITY_ENABLED === "true" && process.env.DEV_USER_EMAIL) {
    headers.set("x-dev-user-email", process.env.DEV_USER_EMAIL);
  }
  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await request.arrayBuffer();
  let response: Response;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { error: "CONTROL_API_UNAVAILABLE", message: "Control API is unavailable" },
      { status: 503 },
    );
  }
  const outgoingHeaders = new Headers();
  // Only the media types the control API itself produces are relayed; anything
  // else becomes an opaque download so the body can never render as HTML.
  const upstreamContentType = relayedContentType(response.headers.get("content-type"));
  if (upstreamContentType) outgoingHeaders.set("content-type", upstreamContentType);
  // A relayed SVG is an image to `<img>` but a document to the address bar;
  // this makes the document case inert.
  const csp = relayedContentSecurityPolicy(upstreamContentType);
  if (csp) outgoingHeaders.set("content-security-policy", csp);
  for (const name of ["content-disposition", "cache-control"]) {
    const value = response.headers.get(name);
    if (value) outgoingHeaders.set(name, value);
  }
  outgoingHeaders.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    headers: outgoingHeaders,
  });
};

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;

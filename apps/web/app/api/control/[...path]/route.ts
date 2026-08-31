import type { NextRequest } from "next/server";

const proxy = async (request: NextRequest, context: { params: Promise<{ path: string[] }> }) => {
  const { path } = await context.params;
  const baseUrl = process.env.CONTROL_API_URL ?? "http://127.0.0.1:3001";
  const target = new URL(path.join("/"), `${baseUrl.replace(/\/$/, "")}/`);
  target.search = request.nextUrl.search;
  const headers = new Headers();
  headers.set("accept", request.headers.get("accept") ?? "application/json");
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accessJwt = request.headers.get("cf-access-jwt-assertion");
  if (accessJwt) headers.set("cf-access-jwt-assertion", accessJwt);
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
  for (const name of ["content-type", "content-disposition", "cache-control"]) {
    const value = response.headers.get(name);
    if (value) outgoingHeaders.set(name, value);
  }
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

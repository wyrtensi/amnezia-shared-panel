import { cookies, headers } from "next/headers";
import { SESSION_COOKIE } from "./session";
import type { Me } from "./types";

/**
 * Fetch from the control API on the server, forwarding the caller's identity
 * the same way the /api/control proxy does: the Cloudflare Access JWT, the
 * direct-login panel session cookie (as x-panel-identity), or the dev identity
 * header when the dev adapter is enabled.
 */
export async function serverApiRequest<T>(path: string): Promise<T> {
  const baseUrl = process.env.CONTROL_API_URL ?? "http://127.0.0.1:3001";
  const target = new URL(
    path.replace(/^\//, ""),
    `${baseUrl.replace(/\/$/, "")}/`,
  );

  const incoming = await headers();
  const outgoing = new Headers({ accept: "application/json" });
  const accessJwt = incoming.get("cf-access-jwt-assertion");
  if (accessJwt) outgoing.set("cf-access-jwt-assertion", accessJwt);
  // Direct login: the session cookie IS the x-panel-identity token the API
  // verifies, so forward it verbatim (same as apps/web/app/api/control).
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (session) outgoing.set("x-panel-identity", session);
  if (
    process.env.DEV_IDENTITY_ENABLED === "true" &&
    process.env.DEV_USER_EMAIL
  ) {
    outgoing.set("x-dev-user-email", process.env.DEV_USER_EMAIL);
  }

  const response = await fetch(target, {
    headers: outgoing,
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Control API request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Resolve the current actor, or null if the control API is unreachable or
 * the caller is unauthenticated.
 */
export async function getMe(): Promise<Me | null> {
  try {
    return await serverApiRequest<Me>("/api/me");
  } catch {
    return null;
  }
}

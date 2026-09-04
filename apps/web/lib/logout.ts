import { cookies, headers } from "next/headers";

import { SESSION_COOKIE } from "./session";

/**
 * How this visitor can sign out.
 *
 * There are two ways into the panel and they end in different places:
 *
 * - `session` - a direct (server-side Google) login. Clearing our own cookie is
 *   the whole of it.
 * - `cloudflare` - the visitor came through Cloudflare Access, which sets its
 *   own cookie on this domain. Clearing `panel_session` would do nothing there,
 *   and the panel used to show NO button at all on that path, which reads as a
 *   missing feature rather than as a deliberate hand-off. `/cdn-cgi/access/logout`
 *   is Cloudflare's own endpoint on this same origin and revokes that session.
 * - `null` - neither, so there is genuinely nothing to sign out of.
 */
export type LogoutMode = "session" | "cloudflare";

export const resolveLogoutMode = async (): Promise<LogoutMode | null> => {
  if ((await cookies()).get(SESSION_COOKIE)?.value) return "session";
  // The edge injects this header on every request it lets through, so its
  // presence is exactly "this page view came through Access".
  if ((await headers()).get("cf-access-jwt-assertion")) return "cloudflare";
  return null;
};

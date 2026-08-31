const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/** Google OAuth config from env, or null if the direct-login path is not set up. */
export const googleConfig = (): GoogleConfig | null => {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const publicUrl = process.env.PANEL_PUBLIC_URL;
  if (!clientId || !clientSecret || !publicUrl) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: `${publicUrl.replace(/\/$/, "")}/api/auth/google/callback`,
  };
};

export const buildAuthorizeUrl = (cfg: GoogleConfig, state: string): string => {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
    access_type: "online",
  });
  return `${AUTH_URL}?${params.toString()}`;
};

const decodeJwtPayload = (jwt: string): Record<string, unknown> => {
  const part = jwt.split(".")[1] ?? "";
  const json = Buffer.from(part, "base64url").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
};

/**
 * Exchange the authorization code for tokens and return the verified Google
 * identity. The exchange is a direct server-to-server TLS call to Google's token
 * endpoint authenticated with the client secret, so the returned id_token is
 * trusted and we read email + sub from it (email must be verified).
 */
export const exchangeCodeForIdentity = async (
  cfg: GoogleConfig,
  code: string,
): Promise<{ email: string; sub: string } | null> => {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) return null;
  const payload = decodeJwtPayload(data.id_token);
  const email =
    typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const emailVerified =
    payload.email_verified === true || payload.email_verified === "true";
  if (!email || !sub || !emailVerified) return null;
  return { email, sub };
};

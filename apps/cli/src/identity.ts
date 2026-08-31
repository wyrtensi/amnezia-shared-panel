import { createHmac } from "node:crypto";

/**
 * How the CLI proves who it is to the control-api. Three sources, in priority
 * order (see {@link authHeaders}). The primary one for a co-located operator is
 * a self-minted panel-session token: whoever runs the CLI on the panel host
 * holds `PANEL_IDENTITY_SECRET`, so they can sign the very same `x-panel-identity`
 * token the web issues after a Google login and drive the admin API without a
 * browser — in production too, unlike the dev header.
 */

// Must match apps/control-api/src/panelSession.ts and apps/web/lib/session.ts.
const PANEL_SESSION_ISSUER = "amnezia-panel-web";
const PANEL_SESSION_AUDIENCE = "amnezia-panel-api";
// Short life: a CLI call is synchronous, so the token never needs to outlive it.
const CLI_TOKEN_TTL_SECONDS = 300;

const base64url = (input: string): string =>
  Buffer.from(input, "utf8").toString("base64url");

/**
 * Sign an HS256 `x-panel-identity` token asserting `email`, identical in shape
 * to the web's session token so the control-api's panel-session adapter accepts
 * it. The shared secret is the trust boundary (anyone holding it can already
 * impersonate the web); the asserted email must be a bootstrap admin or an
 * existing admin to gain admin rights. Dependency-free on purpose (node crypto).
 */
export function signPanelIdentity(
  secret: string,
  email: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      email: email.trim().toLowerCase(),
      provider: "cli",
      sub: email.trim().toLowerCase(),
      iss: PANEL_SESSION_ISSUER,
      aud: PANEL_SESSION_AUDIENCE,
      iat: nowSeconds,
      exp: nowSeconds + CLI_TOKEN_TTL_SECONDS,
    }),
  );
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

/** First email in BOOTSTRAP_ADMIN_EMAILS, the default identity the CLI signs as. */
export function firstBootstrapAdmin(): string | undefined {
  return (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)[0];
}

/**
 * Resolve the auth headers for a control-api request, in priority order:
 *   1. Co-located admin — mint a panel-session token from PANEL_IDENTITY_SECRET
 *      (+ CLI_ADMIN_EMAIL, or the first BOOTSTRAP_ADMIN_EMAILS). Works in prod.
 *   2. Cloudflare Access service token — when the CLI reaches the API through CF.
 *   3. Dev identity — x-dev-user-email (only honoured when the API runs in dev).
 */
export function authHeaders(): Record<string, string> {
  const secret = process.env.PANEL_IDENTITY_SECRET;
  const adminEmail =
    process.env.CLI_ADMIN_EMAIL?.trim().toLowerCase() || firstBootstrapAdmin();
  if (secret && adminEmail) {
    return { "x-panel-identity": signPanelIdentity(secret, adminEmail) };
  }

  const id = process.env.CF_ACCESS_CLIENT_ID;
  const cfSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (id && cfSecret) {
    return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": cfSecret };
  }

  const email = process.env.PANEL_ADMIN_EMAIL;
  if (email) return { "x-dev-user-email": email };

  throw new Error(
    "No credentials. Set PANEL_IDENTITY_SECRET (+ CLI_ADMIN_EMAIL or " +
      "BOOTSTRAP_ADMIN_EMAILS) for a co-located admin, CF_ACCESS_CLIENT_ID + " +
      "CF_ACCESS_CLIENT_SECRET (through Cloudflare Access), or PANEL_ADMIN_EMAIL (dev).",
  );
}

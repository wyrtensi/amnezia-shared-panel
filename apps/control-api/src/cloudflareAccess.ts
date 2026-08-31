import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type { IdentityAdapter } from "./app.js";
import { ApiError } from "./service.js";

export type CloudflareAccessOptions = {
  issuer: string;
  audience: string;
  jwks?: JWTVerifyGetKey;
};

export const createCloudflareAccessAdapter = ({
  issuer: issuerRaw,
  audience,
  jwks,
}: CloudflareAccessOptions): IdentityAdapter => {
  const issuer = issuerRaw.replace(/\/$/, "");
  const keySet =
    jwks ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  return async (request) => {
    const rawToken = request.headers["cf-access-jwt-assertion"];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    if (!token) return null;
    const { payload } = await jwtVerify(token, keySet, {
      issuer,
      audience,
      algorithms: ["RS256"],
    });
    const email = typeof payload.email === "string"
      ? payload.email.trim().toLowerCase()
      : "";
    if (!payload.sub || !email) {
      throw new ApiError(
        401,
        "Access token is missing identity claims",
        "INVALID_IDENTITY_TOKEN",
      );
    }
    return {
      provider: "cloudflare-access",
      subject: payload.sub,
      email,
    };
  };
};

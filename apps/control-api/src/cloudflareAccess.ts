import { jwtVerify, type JWTVerifyGetKey } from "jose";
import type { IdentityAdapter } from "./app.js";
import {
  createJwksFetcher,
  createResilientJWKSet,
} from "./resilientJwks.js";
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
  // Not createRemoteJWKSet: it throws when a refresh fails, and this runs on
  // every authenticated request, so a brief outage at the identity provider
  // returns 500 for the entire API. See resilientJwks.ts.
  const keySet =
    jwks ??
    createResilientJWKSet({
      fetchJwks: createJwksFetcher(new URL(`${issuer}/cdn-cgi/access/certs`)),
    });

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

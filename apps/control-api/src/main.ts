import { createDatabase, type EncryptionKeyring } from "@amnezia/db";
import { buildApp, type IdentityAdapter } from "./app.js";
import { createCloudflareAccessAdapter } from "./cloudflareAccess.js";
import {
  chainIdentityAdapters,
  createPanelSessionAdapter,
} from "./panelSession.js";
import { createDefaultControlApiService } from "./defaultService.js";
import { PostgresControlRepository } from "./postgresRepository.js";

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const parseKeyring = (raw: string): EncryptionKeyring => {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const keyring: Record<number, Buffer> = {};
  for (const [versionRaw, keyRaw] of Object.entries(parsed)) {
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || typeof keyRaw !== "string") {
      throw new Error("CONFIG_ENCRYPTION_KEYS_JSON has an invalid entry");
    }
    const key = Buffer.from(keyRaw, "base64");
    if (key.byteLength !== 32) {
      throw new Error("Every config encryption key must contain 32 bytes");
    }
    keyring[version] = key;
  }
  if (Object.keys(keyring).length === 0) {
    throw new Error("At least one config encryption key is required");
  }
  return keyring;
};

export const parseEnvironment = (
  raw: string | undefined,
): "development" | "test" | "production" => {
  if (!raw) {
    throw new Error("NODE_ENV is required and must be development, test, or production");
  }
  if (
    !(["development", "test", "production"] as const).includes(
      raw as "development" | "test" | "production",
    )
  ) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  return raw as "development" | "test" | "production";
};

export const startServer = async () => {
  const environment = parseEnvironment(process.env.NODE_ENV);

  const database = createDatabase(requiredEnv("DATABASE_URL"));
  const keyring = parseKeyring(requiredEnv("CONFIG_ENCRYPTION_KEYS_JSON"));
  const activeKeyVersion = Number(
    requiredEnv("CONFIG_ENCRYPTION_ACTIVE_VERSION"),
  );
  if (!Number.isInteger(activeKeyVersion) || !keyring[activeKeyVersion]) {
    throw new Error(
      "CONFIG_ENCRYPTION_ACTIVE_VERSION is not present in the keyring",
    );
  }
  const csvSet = (raw: string | undefined) =>
    new Set(
      (raw ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
  const bootstrapAdminEmails = csvSet(process.env.BOOTSTRAP_ADMIN_EMAILS);
  const allowedEmailDomains = csvSet(process.env.AUTH_ALLOWED_DOMAINS);
  const repository = new PostgresControlRepository({
    db: database.db,
    keyring,
    activeKeyVersion,
    bootstrapAdminEmails,
    allowedEmailDomains,
  });
  const service = createDefaultControlApiService({ repository, keyring });
  // Identity methods, tried in order: Cloudflare Access JWT (edge login) then the
  // web app's own signed session (direct/server-side Google login). At least one
  // must be configured in production. Extensible — add more adapters here.
  const adapters: IdentityAdapter[] = [];
  if (process.env.CF_ACCESS_ISSUER && process.env.CF_ACCESS_AUDIENCE) {
    adapters.push(
      createCloudflareAccessAdapter({
        issuer: process.env.CF_ACCESS_ISSUER,
        audience: process.env.CF_ACCESS_AUDIENCE,
      }),
    );
  }
  if (process.env.PANEL_IDENTITY_SECRET) {
    adapters.push(
      createPanelSessionAdapter({ secret: process.env.PANEL_IDENTITY_SECRET }),
    );
  }
  if (environment === "production" && adapters.length === 0) {
    throw new Error(
      "No identity method configured: set CF_ACCESS_ISSUER+CF_ACCESS_AUDIENCE and/or PANEL_IDENTITY_SECRET",
    );
  }
  const identityAdapter =
    adapters.length > 0 ? chainIdentityAdapters(adapters) : undefined;
  // The `x-dev-user-email` header trusts any caller, so the real server enables
  // it only when explicitly opted in (ALLOW_DEV_IDENTITY=true). This way an
  // accidental NODE_ENV=development on an exposed host cannot bypass auth; the
  // dev compose and .env.example set the flag so the local flow is unaffected.
  const allowDevIdentity =
    environment === "development" &&
    process.env.ALLOW_DEV_IDENTITY === "true";
  const app = await buildApp({
    service,
    environment,
    identityAdapter,
    logger: true,
    allowDevIdentity,
  });

  app.addHook("onClose", async () => {
    await database.client.end();
  });

  await app.listen({
    host: process.env.CONTROL_API_HOST ?? "127.0.0.1",
    port: Number(process.env.CONTROL_API_PORT ?? 3001),
  });

  return app;
};

if (process.env.NODE_ENV !== "test") {
  await startServer();
}

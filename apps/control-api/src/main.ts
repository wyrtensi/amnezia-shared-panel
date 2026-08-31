import { createDatabase, type EncryptionKeyring } from "@amnezia/db";
import { buildApp } from "./app.js";
import { createCloudflareAccessAdapter } from "./cloudflareAccess.js";
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
  const bootstrapAdminEmails = new Set(
    (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  const repository = new PostgresControlRepository({
    db: database.db,
    keyring,
    activeKeyVersion,
    bootstrapAdminEmails,
  });
  const service = createDefaultControlApiService({ repository, keyring });
  const identityAdapter =
    environment === "production"
      ? createCloudflareAccessAdapter({
          issuer: requiredEnv("CF_ACCESS_ISSUER"),
          audience: requiredEnv("CF_ACCESS_AUDIENCE"),
        })
      : undefined;
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

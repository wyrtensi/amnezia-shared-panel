import { createHash } from "node:crypto";
import { awgGeneratorSettingsSchema } from "@amnezia/contracts";

export {
  awgClientProfileV1Schema,
  AWG_PROFILE_GAP,
  AWG_PROFILE_JC,
  AWG_PROFILE_JMIN,
  AWG_PROFILE_ORDERS,
  profileOrder,
  profileRevision,
  selectAwgClientProfile,
  type AwgClientProfileV1,
} from "@amnezia/vpn-config";

/**
 * The precondition a refresh must present: lowercase SHA-256 hex of the
 * JSON tuple `[keyId, nonce, revision]`. A new nonce means the node issued a
 * new config (a rotation), a new revision means someone refreshed already;
 * either turns an old token stale. Configured generator settings are included
 * canonically so a changed preset also invalidates the token. Owner and policy
 * are checked separately.
 */
export const configRefreshToken = (
  keyId: string,
  nonce: string,
  revision: number,
  generator?: unknown,
): string =>
  createHash("sha256").update(JSON.stringify(generator == null
    ? [keyId, nonce, revision]
    : [keyId, nonce, revision, awgGeneratorSettingsSchema.parse(generator)])).digest("hex");

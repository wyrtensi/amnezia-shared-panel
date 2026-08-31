import QRCode from "qrcode";
import type { EncryptionKeyring } from "@amnezia/db";
import { decryptSecret } from "@amnezia/db";
import type { PortalPolicy } from "@amnezia/contracts";
import type { ControlRepository } from "./repository.js";
import {
  ApiError,
  type ConfigFormat,
  type ConfigResult,
  type ControlApiService,
} from "./service.js";
import {
  applyRouteProfileToVpnLink,
  extractConfFromVpnLink,
  mergeRulePayload,
} from "./vpnConfig.js";

export type DefaultServiceOptions = {
  repository: ControlRepository;
  keyring: EncryptionKeyring;
};

const assertDownloadAllowed = (
  policy: PortalPolicy,
  format: ConfigFormat,
): void => {
  const allowed =
    policy.allowConfigRedownload &&
    (format === "vpn" ||
      (format === "qr" && policy.allowQrDownload) ||
      (format === "conf" && policy.allowConfDownload));
  if (!allowed) {
    throw new ApiError(403, "Config download is disabled", "POLICY_DENIED");
  }
};

const safeFilename = (value: string | null): string => {
  const cleaned = (value ?? "amnezia-key")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || "amnezia-key";
};

export const createDefaultControlApiService = ({
  repository,
  keyring,
}: DefaultServiceOptions): ControlApiService => ({
  resolveIdentity: (claim) => repository.resolveIdentity(claim),
  getMe: async (actor) => ({
    id: actor.id,
    email: actor.email,
    displayName: actor.displayName,
    role: actor.role,
    status: actor.status,
    ...(await repository.getMe(actor)),
  }),
  listNodes: (actor) => repository.listNodes(actor),
  listKeys: (actor) => repository.listKeys(actor),
  requestKey: (actor, request) =>
    repository.createProvisioningKey(actor, request),
  getKeyConfig: async (
    actor,
    keyId,
    format,
    adminConfirmed,
  ): Promise<ConfigResult> => {
    const key = await repository.findKeyConfig(keyId);
    if (!key || (actor.role !== "admin" && key.ownerId !== actor.id)) {
      throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
    }
    const isAdminView = actor.role === "admin" && key.ownerId !== actor.id;
    if (isAdminView && !adminConfirmed) {
      throw new ApiError(
        409,
        "Explicit confirmation is required",
        "ADMIN_CONFIRMATION_REQUIRED",
      );
    }
    if (!isAdminView) {
      assertDownloadAllowed(key.policy, format);
    }

    const storedLink = decryptSecret(key.encrypted, keyring);
    // Apply the active routing rules for non-full-tunnel profiles at export time.
    // AmneziaVPN clients cannot refresh routing on an imported config, so every
    // export carries the current rules and clears the "outdated" flag. The
    // owner's per-profile custom routes are unioned on top of the base feed (and
    // apply even when no base feed is active yet).
    const customExtra =
      key.routeProfile === "full_tunnel"
        ? undefined
        : key.customRoutes?.[key.routeProfile];
    const mergedPayload = mergeRulePayload(
      key.activeRule?.payload ?? { cidrs: [], domains: [] },
      customExtra,
    );
    const hasRoutes =
      mergedPayload.cidrs.length > 0 || mergedPayload.domains.length > 0;
    const vpnLink =
      key.routeProfile !== "full_tunnel" && hasRoutes
        ? applyRouteProfileToVpnLink(storedLink, key.routeProfile, mergedPayload)
        : storedLink;
    if (
      key.activeRule &&
      key.appliedRuleVersionId !== key.activeRule.versionId
    ) {
      await repository.markKeyRuleVersion(key.id, key.activeRule.versionId);
    }
    if (isAdminView) {
      await repository.appendAudit({
        actorUserId: actor.id,
        actorType: "user",
        action: "vpn_key.private_config_viewed",
        targetType: "vpn_key",
        targetId: key.id,
        metadata: { format },
      });
    }

    if (format === "vpn") {
      return {
        format,
        contentType: "text/plain; charset=utf-8",
        body: vpnLink,
        filename: `${safeFilename(key.deviceLabel)}.vpn.txt`,
      };
    }
    if (format === "conf") {
      return {
        format,
        contentType: "text/plain; charset=utf-8",
        body: extractConfFromVpnLink(vpnLink),
        filename: `${safeFilename(key.deviceLabel)}.conf`,
      };
    }
    return {
      format,
      contentType: "image/png",
      body: await QRCode.toBuffer(vpnLink, {
        type: "png",
        // Higher error correction ("Q" = ~25%) survives low-quality cameras,
        // glare and partial occlusion far better than the default "M".
        errorCorrectionLevel: "Q",
        margin: 2,
        width: 1024,
      }),
      filename: `${safeFilename(key.deviceLabel)}.png`,
    };
  },
  revokeOwnKey: (actor, keyId) => repository.enqueueOwnRevoke(actor, keyId),
  rotateOwnKey: (actor, keyId) => repository.enqueueOwnRotate(actor, keyId),
  updateMyCustomRoutes: (actor, routes) =>
    repository.updateOwnCustomRoutes(actor, routes),
  listRouteProfiles: () => repository.listRouteProfiles(),
  getRuleVersion: (_actor, id) => repository.getRuleVersion(id),
  diffRuleVersions: (_actor, baseId, nextId) =>
    repository.diffRuleVersions(baseId, nextId),
  listQuotaRequests: (actor) => repository.listQuotaRequests(actor),
  createQuotaRequest: (actor, request) =>
    repository.createQuotaRequest(actor, request),
  getAdminOverview: (actor) => repository.getAdminOverview(actor),
  trafficSeries: (actor, { scope, days }) =>
    repository.trafficSeries({
      ownerId: scope === "self" ? actor.id : undefined,
      days,
    }),
  nodeTrafficPeriods: (actor, { scope }) =>
    repository.nodeTrafficPeriods({
      ownerId: scope === "self" ? actor.id : undefined,
    }),
  createUser: (actor, request) => repository.createUser(actor, request),
  createNode: (actor, request) => repository.createNode(actor, request),
  updateNode: (actor, nodeId, request) =>
    repository.updateNode(actor, nodeId, request),
  deleteNode: (actor, nodeId) => repository.deleteNode(actor, nodeId),
  adminList: (actor, resource) => repository.adminList(actor, resource),
  adminAction: (actor, resource, targetId, action, payload) =>
    repository.adminAction(actor, resource, targetId, action, payload),
});

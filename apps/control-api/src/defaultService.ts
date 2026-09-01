import QRCode from "qrcode";
import type { EncryptionKeyring } from "@amnezia/db";
import { decryptSecret } from "@amnezia/db";
import type { PortalPolicy } from "@amnezia/contracts";
import { composeKeyDisplayName } from "@amnezia/contracts";
import type { ControlRepository } from "./repository.js";
import { mergeRoutePayload } from "./routeMerge.js";
import {
  ApiError,
  type ConfigFormat,
  type ConfigResult,
  type ControlApiService,
} from "./service.js";
import {
  applyRouteProfileToVpnLink,
  extractConfFromVpnLink,
  setVpnDescription,
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
    // export carries the current rules and clears the "outdated" flag. On top of
    // the base feed we apply the admin's global exclusions, then the admin's
    // global additions, then the owner's own custom routes (which therefore
    // re-add anything the admin excluded). All of it applies even when no base
    // feed is active yet.
    const splitProfile =
      key.routeProfile === "full_tunnel" ? null : key.routeProfile;
    const globalRoutes = splitProfile
      ? await repository.getGlobalRoutes()
      : null;
    const mergedPayload = mergeRoutePayload({
      base: key.activeRule?.payload ?? { cidrs: [], domains: [] },
      global: splitProfile ? globalRoutes?.[splitProfile] : null,
      userExtra: splitProfile ? key.customRoutes?.[splitProfile] : null,
    });
    const hasRoutes =
      mergedPayload.cidrs.length > 0 || mergedPayload.domains.length > 0;
    const routedLink =
      key.routeProfile !== "full_tunnel" && hasRoutes
        ? applyRouteProfileToVpnLink(storedLink, key.routeProfile, mergedPayload)
        : storedLink;
    // Label the connection in the client with the parts this key was created
    // with, so a user with several keys can tell their servers apart.
    const displayName = composeKeyDisplayName({
      serverName: key.nodeDisplayName,
      label: key.deviceLabel,
      keyNumber: key.keyNumber,
      display: key.nameDisplay,
    });
    const vpnLink = setVpnDescription(routedLink, displayName);
    // Only the OWNER downloading their own config marks the rules as applied.
    // An admin peeking at someone's private config must not clear the owner's
    // "rules outdated" indicator (they didn't reinstall anything).
    if (
      !isAdminView &&
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
    // A split-tunnel config embeds thousands of CIDRs, which overflows the QR
    // capacity — QRCode.toBuffer would otherwise throw a raw 500. Refuse with a
    // clear error (the UI hides QR for these profiles and offers the config file).
    let qr: Buffer;
    try {
      qr = await QRCode.toBuffer(vpnLink, {
        type: "png",
        // Higher error correction ("Q" = ~25%) survives low-quality cameras,
        // glare and partial occlusion far better than the default "M".
        errorCorrectionLevel: "Q",
        margin: 2,
        width: 1024,
      });
    } catch {
      throw new ApiError(
        422,
        "This config is too large for a QR code — use the config file instead",
        "QR_TOO_LARGE",
      );
    }
    return {
      format,
      contentType: "image/png",
      body: qr,
      filename: `${safeFilename(key.deviceLabel)}.png`,
    };
  },
  revokeOwnKey: (actor, keyId) => repository.enqueueOwnRevoke(actor, keyId),
  rotateOwnKey: (actor, keyId) => repository.enqueueOwnRotate(actor, keyId),
  updateMyCustomRoutes: (actor, routes) =>
    repository.updateOwnCustomRoutes(actor, routes),
  listRouteProfiles: () => repository.listRouteProfiles(),
  getRuleVersion: (_actor, id) => repository.getRuleVersion(id),
  getRulesRefreshStatus: () => repository.getRulesRefreshStatus(),
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
  deleteNode: (actor, nodeId, options) =>
    repository.deleteNode(actor, nodeId, options),
  adminList: (actor, resource) => repository.adminList(actor, resource),
  adminAction: (actor, resource, targetId, action, payload) =>
    repository.adminAction(actor, resource, targetId, action, payload),
});

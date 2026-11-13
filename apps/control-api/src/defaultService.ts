import type { EncryptionKeyring } from "@amnezia/db";
import { decryptSecret } from "@amnezia/db";
import type { PortalPolicy } from "@amnezia/contracts";
import {
  composeKeyDisplayName,
  CONFIG_REFRESH_UNAVAILABLE,
} from "@amnezia/contracts";
import {
  awgClientProfileV1Schema,
  configRefreshToken,
  profileRevision,
  selectAwgClientProfile,
} from "./awgClientProfile.js";
import type { ControlRepository, StoredKeyConfig } from "./repository.js";
import { mergeRoutePayload } from "./routeMerge.js";
import {
  ApiError,
  type ConfigFormat,
  type ConfigResult,
  type ControlApiService,
} from "./service.js";
import {
  applyAwgClientProfile,
  applyRouteProfileToVpnLink,
  extractConfFromVpnLink,
  inspectAwg31ClientConfig,
  setVpnDescription,
} from "./vpnConfig.js";
import { inspectAwgVpnLink, type AwgEndpoint } from "@amnezia/vpn-config";
import { decideBridgeDelivery, renderBridgeEndpoint } from "./bridgeEndpoint.js";
import { configFilename } from "./configFilename.js";
import { buildQrFrameTexts } from "./qrFrames.js";
import { renderKeyQr, type RenderedQr } from "./qrRender.js";

/**
 * The most frames a person will actually scan. This is a product limit, not a
 * format one: the envelope's own ceiling is 255 (a one-byte counter), which no
 * real config would ever reach.
 */
const QR_MAX_USABLE_FRAMES = 8;

/** How the symbol was drawn, for the response headers the CLI prints. */
const describeQr = (rendered: RenderedQr): ConfigResult["qrParams"] => ({
  errorCorrectionLevel: rendered.params.errorCorrectionLevel,
  modules: rendered.modules,
  scale: rendered.params.scale,
});

/**
 * Every QR format refuses the same way when a payload will not fit: a
 * split-tunnel config carries thousands of CIDRs, and no error-correction
 * level can hold that much text in one symbol. The UI hides QR entirely for
 * non-full-tunnel profiles, so this is reached only through a direct request
 * (the CLI, or an admin's confirmed view) — but it still has to answer with a
 * clear refusal rather than a raw 500 from the QR library. Repeated inline at
 * each call site rather than factored into a helper: `only-throw-error`
 * flags a `throw` of a function call's result even when that function's
 * return type is `never`, so a helper would need a lint suppression to buy
 * nothing but a shorter `throw` line.
 */
const QR_TOO_LARGE_MESSAGE =
  "This config is too large for a QR code — use the config file instead";

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
      // All four QR containers are the same capability: an admin who turned QR
      // off must not get it back through a new format string.
      ((format === "qr" ||
        format === "qr-svg" ||
        format === "qr-frames" ||
        format === "qr-conf") &&
        policy.allowQrDownload) ||
      (format === "conf" && policy.allowConfDownload));
  if (!allowed) {
    throw new ApiError(403, "Config download is disabled", "POLICY_DENIED");
  }
};

/**
 * The saved client profile over the node-issued artifact. Comes first, so the
 * route and name overlays apply to it like to any other export. A 2.0 or
 * unmarked artifact comes back as it is, whatever was saved.
 */
const withClientProfile = (base: string, profile: unknown): string => {
  if (profile === null || profile === undefined) return base;
  try {
    return applyAwgClientProfile(base, profile);
  } catch {
    throw new ApiError(
      500,
      "The saved client profile of this key is invalid",
      "CONFIG_PROFILE_INVALID",
    );
  }
};

/**
 * The link a download serves, built from the key's decrypted saved artifact:
 * the saved client profile, then the endpoint (`endpoint` null keeps the
 * artifact's own), then the route profile's current rules, then the
 * connection name. Reads only; it marks nothing as delivered.
 */
const composeExport = async (
  repository: ControlRepository,
  key: StoredKeyConfig,
  savedLink: string,
  endpoint: AwgEndpoint | null,
): Promise<{ vpnLink: string; displayName: string }> => {
  const profiledLink = withClientProfile(savedLink, key.awgClientProfile);
  const storedLink =
    endpoint === null ? profiledLink : renderBridgeEndpoint(profiledLink, endpoint);
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
  // Addresses only: a merged payload with nothing to put in AllowedIPs has
  // no way to narrow the tunnel, so the key ships as the full tunnel it is.
  const hasRoutes = mergedPayload.cidrs.length > 0;
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
  return { vpnLink, displayName };
};

const unavailable = () =>
  new ApiError(409, "This key cannot refresh its config", CONFIG_REFRESH_UNAVAILABLE);

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
  ackNotice: (actor, kind) => repository.ackNotice(actor, kind),
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

    // The saved artifact stays the direct source; export never rewrites it.
    // The Direct/bridge decision inspects the artifact as saved (before the
    // client profile), so it does not depend on the profile validator. An
    // unsupported AWG3 artifact with an active bridge refuses here, before
    // any route accounting below.
    const savedLink = decryptSecret(key.encrypted, keyring);
    const delivery = decideBridgeDelivery(
      key.protocol,
      savedLink,
      key.bridgeEndpoint,
    );
    const { vpnLink, displayName } = await composeExport(
      repository,
      key,
      savedLink,
      delivery.mode === "bridge" ? delivery.endpoint : null,
    );
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
        // `.vpn`, not the `.vpn.txt` this used to be. These bytes are the ONLY
        // downloadable shape that survives an import with its name: the client
        // reads the file's content, not its extension, but its file picker only
        // offers `*.vpn *.ovpn *.conf *.json`, so a `.txt` suffix hid the one
        // shape that works. See configFilename.ts for the client sources.
        filename: configFilename(displayName, "vpn"),
      };
    }
    if (format === "conf") {
      return {
        format,
        contentType: "text/plain; charset=utf-8",
        body: extractConfFromVpnLink(vpnLink),
        // A `.conf` import is always named "Server N" by the client, whatever
        // the file says or is called. Naming the download after the connection
        // is the most this shape can do: it tells the user what to rename that
        // "Server N" to. Nothing is written INTO the file — a name comment the
        // parser ignores would only look like a fix.
        filename: configFilename(displayName, "conf"),
      };
    }
    if (format === "qr-conf") {
      // AmneziaWG reads neither the chunk envelope nor the `vpn://` link, only
      // a plain WireGuard config, so this QR carries the same text `conf`
      // downloads as a file. Same capacity ceiling as the `vpn://` symbol, so
      // a split-tunnel key's `.conf` refuses the same way.
      const confText = extractConfFromVpnLink(vpnLink);
      let rendered: RenderedQr;
      try {
        rendered = await renderKeyQr(confText, "svg");
      } catch {
        throw new ApiError(422, QR_TOO_LARGE_MESSAGE, "QR_TOO_LARGE");
      }
      // A display format, not a download: no content-disposition, no filename,
      // same as `qr-svg`.
      return {
        format,
        contentType: rendered.contentType,
        body: rendered.body,
        qrParams: describeQr(rendered),
      };
    }
    // A split-tunnel config embeds thousands of CIDRs and overflows QR capacity
    // at every error-correction level — the renderer would otherwise throw a raw
    // 500. Refuse with a clear error (the UI hides QR for these profiles and
    // offers the config file instead).
    if (format === "qr-frames") {
      // AmneziaVPN's in-app scanner reads only its own chunk envelope, never a
      // `vpn://` URL, so this is a different payload rather than a different
      // picture of the same one. Rendered as SVG so it inherits the quiet zone
      // and crisp edges, and so the panel's zoom slider works on it.
      let frames: string[];
      let firstParams: ConfigResult["qrParams"];
      try {
        const texts = buildQrFrameTexts(vpnLink);
        // Chunking removes the capacity limit that makes the single-frame
        // formats refuse a split-tunnel config, so without this a blacklist key
        // would return dozens of codes (a 20 KB config is 24 frames) instead of
        // the 422 every other QR format gives it. Nobody scans 24 codes; the
        // config file is the answer for those keys. Eight is well clear of a
        // full-tunnel key (860 bytes, two frames) and still a few seconds of
        // holding a phone at the animation, so it refuses only what is
        // genuinely unusable.
        if (texts.length > QR_MAX_USABLE_FRAMES) {
          throw new Error("too many frames to scan");
        }
        const drawn = await Promise.all(
          texts.map((text) => renderKeyQr(text, "svg")),
        );
        frames = drawn.map((frame) => String(frame.body));
        firstParams = drawn[0] && describeQr(drawn[0]);
      } catch {
        throw new ApiError(422, QR_TOO_LARGE_MESSAGE, "QR_TOO_LARGE");
      }
      return {
        format,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ total: frames.length, frames }),
        // Every frame is chunked to the same size, so frame 0's parameters
        // describe the series.
        qrParams: firstParams,
      };
    }
    let rendered: RenderedQr;
    try {
      rendered = await renderKeyQr(vpnLink, format === "qr-svg" ? "svg" : "png");
    } catch {
      throw new ApiError(422, QR_TOO_LARGE_MESSAGE, "QR_TOO_LARGE");
    }
    if (rendered.kind === "svg") {
      // A display format, not a download: no content-disposition, no filename.
      return {
        format,
        contentType: rendered.contentType,
        body: rendered.body,
        qrParams: describeQr(rendered),
      };
    }
    return {
      format,
      contentType: rendered.contentType,
      body: rendered.body,
      filename: configFilename(displayName, "png"),
      qrParams: describeQr(rendered),
    };
  },
  revokeOwnKey: (actor, keyId) => repository.enqueueOwnRevoke(actor, keyId),
  rotateOwnKey: (actor, keyId) => repository.enqueueOwnRotate(actor, keyId),
  getConfigRefresh: async (actor, keyId) => {
    const key = await repository.findKeyConfig(keyId);
    // Owner only: an admin may view someone's config, not change it.
    if (!key || key.ownerId !== actor.id) {
      throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
    }
    if (!key.policy.allowConfigRedownload) {
      throw new ApiError(403, "Config download is disabled", "POLICY_DENIED");
    }
    if (key.state !== "active") return { eligible: false };
    if (!inspectAwg31ClientConfig(decryptSecret(key.encrypted, keyring))) {
      return { eligible: false };
    }
    const revision = profileRevision(key.awgClientProfile);
    return {
      eligible: true,
      revision,
      refreshToken: configRefreshToken(key.id, key.encrypted.nonce, revision),
    };
  },
  refreshOwnConfig: (actor, keyId, refreshToken) =>
    repository.refreshOwnConfigProfile(actor, keyId, refreshToken, (snapshot) => {
      const base = decryptSecret(snapshot.encrypted, keyring);
      const current = inspectAwg31ClientConfig(base);
      if (!current) throw unavailable();
      // The effective Jc: the saved one, or the node's when nothing is saved.
      const saved = awgClientProfileV1Schema.safeParse(snapshot.awgClientProfile);
      const candidate = selectAwgClientProfile(
        snapshot.revision + 1,
        saved.success ? saved.data.jc : current.jc,
      );
      // Saved only if every copy of the projected config agrees on it.
      const projected = inspectAwg31ClientConfig(
        applyAwgClientProfile(base, candidate),
      );
      if (
        projected?.jc !== candidate.jc ||
        projected.jmin !== candidate.jmin ||
        projected.jmax !== candidate.jmax
      ) {
        throw unavailable();
      }
      return candidate;
    }),
  renameOwnKey: (actor, keyId, deviceLabel) =>
    repository.renameOwnKey(actor, keyId, deviceLabel),
  updateMyCustomRoutes: (actor, routes) =>
    repository.updateOwnCustomRoutes(actor, routes),
  listRouteProfiles: () => repository.listRouteProfiles(),
  getRuleVersion: (_actor, id) => repository.getRuleVersion(id),
  getRulesRefreshStatus: () => repository.getRulesRefreshStatus(),
  getAccessSyncStatus: () => repository.getAccessSyncStatus(),
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
  createServiceCheck: (actor, request) =>
    repository.createServiceCheck(actor, request),
  updateServiceCheck: (actor, checkId, request) =>
    repository.updateServiceCheck(actor, checkId, request),
  deleteServiceCheck: (actor, checkId) =>
    repository.deleteServiceCheck(actor, checkId),
  resetServiceCheckResults: (actor, checkId) =>
    repository.resetServiceCheckResults(actor, checkId),
  runServiceCheckNow: (actor, checkId) =>
    repository.runServiceCheckNow(actor, checkId),
  getReachability: (actor) => repository.getReachability(actor),
  upsertReachabilityProbe: (actor, request) =>
    repository.upsertReachabilityProbe(actor, request),
  deleteReachabilityProbe: (actor) => repository.deleteReachabilityProbe(actor),
  runReachabilityNow: (actor) => repository.runReachabilityNow(actor),
  listReachabilityHistory: (actor, query) =>
    repository.listReachabilityHistory(actor, query),
  adminAction: (actor, resource, targetId, action, payload) =>
    repository.adminAction(actor, resource, targetId, action, payload),
  listBridges: (actor) => repository.listBridges(actor),
  createBridge: (actor, request) => repository.createBridge(actor, request),
  updateBridge: (actor, bridgeId, request) =>
    repository.updateBridge(actor, bridgeId, request),
  deleteBridge: (actor, bridgeId) => repository.deleteBridge(actor, bridgeId),
  getNodeBridgeRoutes: (actor, nodeId) =>
    repository.getNodeBridgeRoutes(actor, nodeId),
  getBridgeEligibility: (actor, nodeId) =>
    repository.getBridgeEligibility(actor, nodeId),
  prepareBridgeRoute: (actor, nodeId, request) =>
    repository.prepareBridgeRoute(actor, nodeId, request),
  releaseBridgeRoute: (actor, routeId) =>
    repository.releaseBridgeRoute(actor, routeId),
  listInfrastructure: (actor) => repository.listInfrastructure(actor),
  getBridgeRouteTestConfig: async (actor, routeId, keyId) => {
    const route = await repository.findBridgeRouteTarget(routeId);
    if (!route) {
      throw new ApiError(404, "Bridge route not found", "BRIDGE_ROUTE_NOT_FOUND");
    }
    if (route.state === "active") {
      throw new ApiError(
        409,
        "The route is already the node's active endpoint; a normal download serves it",
        "BRIDGE_ROUTE_ACTIVE",
      );
    }
    const key = await repository.findKeyConfig(keyId);
    // The administrator's own key only: there is no admin-view path here, so
    // another owner's key reads as unknown.
    if (!key || key.ownerId !== actor.id) {
      throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
    }
    if (key.nodeId !== route.nodeId) {
      throw new ApiError(
        403,
        "The test key must be on the route's VPN node",
        "BRIDGE_TEST_KEY_WRONG_NODE",
      );
    }
    if (key.state !== "active") {
      throw new ApiError(
        409,
        "The test key must be active",
        "BRIDGE_TEST_KEY_UNSUITABLE",
      );
    }
    // The normal redownload policy, as for the owner's own `.vpn` download.
    assertDownloadAllowed(key.policy, "vpn");
    const savedLink = decryptSecret(key.encrypted, keyring);
    // A bridge carries the AWG 3.1 listener only: the saved artifact itself
    // must be 3.1 (not AWG 2, not the 2.0 fallback, not unmarked).
    if (key.protocol !== "awg3" || inspectAwgVpnLink(savedLink).kind !== "awg31") {
      throw new ApiError(
        409,
        "The test key must be an AWG 3.1 key",
        "BRIDGE_TEST_KEY_UNSUITABLE",
      );
    }
    const { vpnLink, displayName } = await composeExport(repository, key, savedLink, {
      host: route.bridgePublicIpv4,
      port: route.publicUdpPort,
    });
    // Deliberately no `markKeyRuleVersion`: a preview is not a delivery, so
    // the key's "rules outdated" state and the active assignment stay as
    // they are. IDs only in the audit event.
    await repository.appendAudit({
      actorUserId: actor.id,
      actorType: "user",
      action: "vpn_bridge_route.test_config_issued",
      targetType: "vpn_bridge_route",
      targetId: route.id,
      metadata: { keyId: key.id, nodeId: route.nodeId, bridgeId: route.bridgeId },
    });
    return {
      contentType: "text/plain; charset=utf-8",
      body: vpnLink,
      filename: configFilename(displayName, "vpn"),
      registrationMarker: route.observedRegistrationMarker,
    };
  },
  verifyBridgeRoute: (actor, routeId, request) =>
    repository.verifyBridgeRoute(actor, routeId, request),
});

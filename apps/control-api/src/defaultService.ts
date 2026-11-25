import type { EncryptionKeyring } from "@amnezia/db";
import { decryptSecret } from "@amnezia/db";
import { createHash } from "node:crypto";
import type { AdminClientParameters, AwgGeneratorSettings, GlobalRoutes, PortalPolicy } from "@amnezia/contracts";
import {
  composeKeyDisplayName,
  CONFIG_REFRESH_UNAVAILABLE,
  AWG_DEFAULT_CLIENT_MTU,
  VPN_CLIPBOARD_MAX_CHARS,
} from "@amnezia/contracts";
import {
  awgClientProfileV1Schema,
  AWG_PROFILE_ORDERS,
  configRefreshToken,
  profileRevision,
  selectAwgClientProfile,
  type AwgClientProfileV1,
} from "./awgClientProfile.js";
import type { ControlRepository, StoredKeyConfig } from "./repository.js";
import { mergeRoutePayload } from "./routeMerge.js";
import {
  ApiError,
  type Actor,
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
import {
  applyDnsToVpnLink,
  AwgClientProfileError,
  DEFAULT_AWG3_SERVER_IPV4_CIDR,
  deriveStubPeerIpv6,
  inspectAwgVpnLink,
  projectAwgClientConfig,
  readAwg31ClientParameters,
  readBaseClientIpv4,
  withIpv6RejectStubAddress,
  type AwgEndpoint,
} from "@amnezia/vpn-config";
import { decideBridgeDelivery, renderBridgeEndpoint } from "./bridgeEndpoint.js";
import {
  verifyNodeEgressIpViaAgent,
  type NodeEgressVerifier,
} from "./nodeEgressVerifier.js";
import { selectDirectAddress } from "./nodeEndpoint.js";
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
  verifyNodeEgress?: NodeEgressVerifier;
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

const projectKeyClientConfig = (base: string, options: Parameters<typeof projectAwgClientConfig>[1]): string => {
  try {
    return projectAwgClientConfig(base, options);
  } catch (error) {
    if (!(error instanceof AwgClientProfileError)) throw error;
    throw new ApiError(
      500,
      "The saved client profile of this key is invalid",
      "CONFIG_PROFILE_INVALID",
    );
  }
};

/**
 * The projection every download and the parameters view share, so the view
 * cannot drift from what a download carries.
 */
const projectExportClientLink = (
  savedLink: string,
  source: {
    protocol: "awg2" | "awg3";
    keyId: string;
    clientProfile: unknown;
    generator: AwgGeneratorSettings | null | undefined;
    mtu: number | undefined;
  },
): string =>
  projectKeyClientConfig(savedLink, {
    protocol: source.protocol,
    keyId: source.keyId,
    clientProfile: source.clientProfile,
    generator: source.generator,
    ...(source.mtu === undefined ? {} : { mtu: source.mtu }),
  });

const requireAdmin = (actor: Actor): void => {
  if (actor.role !== "admin") {
    throw new ApiError(403, "Administrator role required", "FORBIDDEN");
  }
};

/** Exported and issued parameters of one saved artifact, 409 when it is not AWG 3.1. */
const readParameterViews = (
  savedLink: string,
  source: Parameters<typeof projectExportClientLink>[1],
): Pick<AdminClientParameters, "exported" | "issued"> => {
  const unsupported = () =>
    new ApiError(409, "Client parameters require AWG 3.1", "AWG_GENERATOR_UNSUPPORTED");
  if (source.protocol !== "awg3") throw unsupported();
  const issued = readAwg31ClientParameters(savedLink);
  const exported = issued && readAwg31ClientParameters(projectExportClientLink(savedLink, source));
  if (!issued || !exported) throw unsupported();
  return { exported, issued };
};

/** How many revisions a refresh tries before calling a profile unchangeable. */
const REFRESH_REVISION_SEARCH = 16;

const nextClientProfile = (
  base: string,
  previous: unknown,
  revision: number,
  keyId: string,
  generator?: AwgGeneratorSettings | null,
): AwgClientProfileV1 | null => {
  const current = inspectAwg31ClientConfig(base);
  if (!current) return null;
  const saved = awgClientProfileV1Schema.safeParse(previous);
  const jc = saved.success ? saved.data.jc : current.jc;
  if (!generator) return selectAwgClientProfile(revision + 1, jc);
  // One shared set for every key: no revision draws anything else.
  if (generator.randomizeKeys === false) return null;
  // Generator draws are independent per revision, so the next one can land
  // on the same config in a narrow range: try the following revisions.
  const options = { protocol: "awg3" as const, keyId, generator };
  const existing = projectKeyClientConfig(base, { ...options, clientProfile: previous });
  for (let step = 1; step <= REFRESH_REVISION_SEARCH; step += 1) {
    const candidate = selectAwgClientProfile(revision + step, jc);
    for (let order = 0; order < AWG_PROFILE_ORDERS; order += 1) {
      const next = { ...candidate, cpsOrder: (candidate.cpsOrder + order) % AWG_PROFILE_ORDERS };
      const updated = projectKeyClientConfig(base, { ...options, clientProfile: next });
      if (updated !== existing) return next;
    }
  }
  return null;
};

const applyIpv6RejectStub = (
  key: StoredKeyConfig,
  link: string,
  format: ConfigFormat,
): string => {
  if (
    key.protocol !== "awg3" ||
    !key.nodeIpv6RejectStub?.enabled ||
    key.nodeIpv6RejectStub.state !== "active"
  ) {
    return link;
  }
  const isConfFormat = format === "conf" || format === "qr-conf";
  const isMobileVpn = key.deviceType === "ios" || key.deviceType === "android";
  // Official desktop AmneziaVPN clients break on comma-separated client_ip, so
  // vpn:// and QR exports only inject the stub ULA on iOS and Android.
  // Standalone .conf / qr-conf supports dual-stack Address on every OS.
  if (!isConfFormat && !isMobileVpn) {
    return link;
  }
  const baseIpv4 = readBaseClientIpv4(link);
  if (!baseIpv4) return link;
  const peerIpv6 = deriveStubPeerIpv6(
    baseIpv4,
    DEFAULT_AWG3_SERVER_IPV4_CIDR,
    key.nodeIpv6RejectStub.prefix,
  );
  if (!peerIpv6) return link;
  return withIpv6RejectStubAddress(link, peerIpv6, {
    includeClientIp: !isConfFormat,
  });
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
  format: ConfigFormat = "vpn",
): Promise<{ vpnLink: string; displayName: string; globalRoutes: GlobalRoutes | null }> => {
  const clientLink = projectExportClientLink(savedLink, {
    protocol: key.protocol,
    keyId: key.id,
    clientProfile: key.awgClientProfile,
    generator: key.awgGenerator,
    mtu: key.awgMtu,
  });
  const profiledLink = applyIpv6RejectStub(key, clientLink, format);
  const storedLink =
    endpoint === null ? profiledLink : renderBridgeEndpoint(profiledLink, endpoint);
  const dnsLink = key.egressDns
    ? applyDnsToVpnLink(storedLink, key.egressDns.dns1, key.egressDns.dns2)
    : storedLink;
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
      ? applyRouteProfileToVpnLink(dnsLink, key.routeProfile, mergedPayload)
      : dnsLink;
  // Label the connection in the client with the parts this key was created
  // with, so a user with several keys can tell their servers apart.
  const displayName = composeKeyDisplayName({
    serverName: key.nodeDisplayName,
    label: key.deviceLabel,
    keyNumber: key.keyNumber,
    display: key.nameDisplay,
  });
  const vpnLink = setVpnDescription(routedLink, displayName);
  return { vpnLink, displayName, globalRoutes };
};

const renderConfigExport = async (
  vpnLink: string,
  displayName: string,
  format: ConfigFormat,
): Promise<ConfigResult> => {
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
};

const unavailable = () =>
  new ApiError(409, "This key cannot refresh its config", CONFIG_REFRESH_UNAVAILABLE);

export const createDefaultControlApiService = ({
  repository,
  keyring,
  verifyNodeEgress = verifyNodeEgressIpViaAgent,
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
    repository.createProvisioningKey(actor, request, {
      allowBridgeSelection: actor.role === "admin",
    }),
  getKeyClientParameters: async (actor, keyId) => {
    requireAdmin(actor);
    const key = await repository.findKeyConfig(keyId);
    if (!key) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
    const views = readParameterViews(decryptSecret(key.encrypted, keyring), {
      protocol: key.protocol,
      keyId: key.id,
      clientProfile: key.awgClientProfile,
      generator: key.awgGenerator,
      mtu: key.awgMtu,
    });
    return {
      ...views,
      settings: {
        profileFrom: key.awgSettingsFrom?.profileFrom ?? null,
        mtuFrom: key.awgSettingsFrom?.mtuFrom ?? "default",
        preset: key.awgGenerator?.preset ?? null,
        mtu: key.awgMtu ?? AWG_DEFAULT_CLIENT_MTU,
        deviceType: key.deviceType ?? "unspecified",
        ownerId: key.ownerId,
      },
    };
  },
  getNodeClientParameters: async (actor, nodeId, endpointId) => {
    requireAdmin(actor);
    // The repository answers null both for a node without a service key and
    // for an address that is not the node's; the two cannot be told apart.
    const sample = await repository.findServiceKeyConfig(nodeId, endpointId);
    if (!sample) {
      throw new ApiError(404, "This node has no service key to sample", "SAMPLE_KEY_NOT_FOUND");
    }
    const { settings } = sample;
    const views = readParameterViews(decryptSecret(sample.encrypted, keyring), {
      protocol: sample.protocol,
      keyId: sample.keyId,
      clientProfile: sample.awgClientProfile,
      generator: settings.awgGenerator,
      mtu: settings.mtu,
    });
    return {
      ...views,
      settings: {
        profileFrom: settings.profileFrom,
        mtuFrom: settings.mtuFrom,
        preset: settings.awgGenerator?.preset ?? null,
        mtu: settings.mtu,
        deviceType: "unspecified",
        ownerId: null,
      },
    };
  },
  getKeyConfig: async (
    actor,
    keyId,
    format,
    _adminConfirmed,
    clipboard,
  ): Promise<ConfigResult> => {
    const key = await repository.findKeyConfig(keyId);
    if (!key || (actor.role !== "admin" && key.ownerId !== actor.id)) {
      throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
    }
    const isAdminView = actor.role === "admin" && key.ownerId !== actor.id;
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
    const { vpnLink, displayName, globalRoutes } = await composeExport(
      repository,
      key,
      savedLink,
      delivery.mode === "bridge" ? delivery.endpoint : selectDirectAddress(savedLink, key.directAddress),
      format,
    );
    if (clipboard && vpnLink.length > VPN_CLIPBOARD_MAX_CHARS) {
      throw new ApiError(
        422,
        "This key is too long to paste. Download the .vpn file instead.",
        "KEY_CLIPBOARD_TOO_LONG",
      );
    }
    const result = await renderConfigExport(vpnLink, displayName, format);
    const payload = format === "conf" || format === "qr-conf"
      ? extractConfFromVpnLink(vpnLink)
      : vpnLink;
    const recorded = await repository.recordConfigExport(
      key.id,
      format,
      createHash("sha256").update(payload).digest("hex"),
      { key, globalRoutes, markRuleVersion: !isAdminView },
    );
    if (!recorded) {
      throw new ApiError(409, "The configuration changed while being prepared. Download it again.", "CONFIG_EXPORT_STALE");
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
    return result;
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
    if (!nextClientProfile(
      decryptSecret(key.encrypted, keyring), key.awgClientProfile, revision, key.id, key.awgGenerator,
    )) return { eligible: false };
    return {
      eligible: true,
      revision,
      refreshToken: configRefreshToken(key.id, key.encrypted.nonce, revision, key.awgGenerator, key.awgMtu),
    };
  },
  refreshOwnConfig: (actor, keyId, refreshToken) =>
    repository.refreshOwnConfigProfile(actor, keyId, refreshToken, (snapshot) => {
      const base = decryptSecret(snapshot.encrypted, keyring);
      const candidate = nextClientProfile(
        base, snapshot.awgClientProfile, snapshot.revision, snapshot.keyId, snapshot.awgGenerator,
      );
      if (!candidate) throw unavailable();
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
  setNodeIpv6RejectStub: (actor, nodeId, request) =>
    repository.setNodeIpv6RejectStub(actor, nodeId, request),
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
  getBridgeRotationEvidence: (actor, bridgeId) => repository.getBridgeRotationEvidence(actor, bridgeId),
  upsertReachabilityProbe: (actor, request) =>
    repository.upsertReachabilityProbe(actor, request),
  deleteReachabilityProbe: (actor) => repository.deleteReachabilityProbe(actor),
  runReachabilityNow: (actor, requireNew) => repository.runReachabilityNow(actor, requireNew),
  listReachabilityHistory: (actor, query) =>
    repository.listReachabilityHistory(actor, query),
  adminAction: (actor, resource, targetId, action, payload) =>
    repository.adminAction(actor, resource, targetId, action, payload),
  listBridges: (actor) => repository.listBridges(actor),
  createBridge: (actor, request) => repository.createBridge(actor, request),
  updateBridge: (actor, bridgeId, request) =>
    repository.updateBridge(actor, bridgeId, request),
  deleteBridge: (actor, bridgeId) => repository.deleteBridge(actor, bridgeId),
  getBridgeAgentUpdate: (actor, bridgeId) => repository.getBridgeAgentUpdate(actor, bridgeId),
  getBridgeRollbackPreflight: (actor) => repository.getBridgeRollbackPreflight(actor),
  requestBridgeAgentUpdate: (actor, bridgeId, request) =>
    repository.requestBridgeAgentUpdate(actor, bridgeId, request),
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
  listNodeEgressIps: (actor, nodeId) => repository.listNodeEgressIps(actor, nodeId),
  createNodeEgressIp: (actor, nodeId, request) =>
    repository.createNodeEgressIp(actor, nodeId, request),
  updateNodeEgressIp: (actor, nodeId, ipId, request) =>
    repository.updateNodeEgressIp(actor, nodeId, ipId, request),
  deleteNodeEgressIp: (actor, nodeId, ipId) =>
    repository.deleteNodeEgressIp(actor, nodeId, ipId),
  swapNodeEgressIp: (actor, nodeId, ipId, request) =>
    repository.swapNodeEgressIp(actor, nodeId, ipId, request),
  verifyNodeEgressIp: async (actor, nodeId, ipId, request) => {
    requireAdmin(actor);
    const target = await repository.getNodeEgressVerifyTarget(nodeId, ipId);
    if (!target) {
      throw new ApiError(404, "Exit IP not found on node", "NODE_EGRESS_IP_NOT_FOUND");
    }
    const result = await verifyNodeEgress(target, keyring, request);
    await repository.appendAudit({
      actorUserId: actor.id,
      actorType: "user",
      action: "node.egress_verified",
      targetType: "node",
      targetId: nodeId,
      metadata: {
        egressIpId: ipId,
        egressIpv4: target.egressIpv4,
        ok: result.ok,
        ipMatch: result.ipMatch,
        dnsOk: result.dnsOk,
      },
    });
    return result;
  },
  setNodeEgressMode: (actor, nodeId, request) =>
    repository.setNodeEgressMode(actor, nodeId, request),
  adoptNodeEgressMode: (actor, nodeId) =>
    repository.adoptNodeEgressMode(actor, nodeId),
  reassignKeyEndpoint: (actor, keyId, request) =>
    repository.reassignKeyEndpoint(actor, keyId, request),
});

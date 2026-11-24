import type {
  AdminKey,
  AdminNode,
  AuditEvent,
} from "@/components/admin/admin-data";

export type AuditTranslate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export type AuditPerson = { text: string; role?: string; gone?: boolean };

export type AuditKeyContext = {
  keyId: string;
  nodeId?: string | null;
  endpointId?: string | null;
  endpointName?: string | null;
  ownerId?: string | null;
  deviceLabel?: string | null;
  deviceType?: string | null;
  keyNumber?: number | null;
  internalName?: string | null;
  protocol?: string | null;
  routeProfile?: string | null;
};

export type ResolvedAuditKeyDetails = {
  /** Human-readable key title (device label + number), or null when unknown. */
  title: string | null;
  internalName: string | null;
  /** Server name (with endpoint name when distinct from node name). */
  serverLabel: string | null;
  /** Owner when known and different from the event's actor. */
  owner: AuditPerson | null;
  deviceLabel: string | null;
  protocolLabel: string | null;
  routeLabel: string | null;
  /** Related node IDs (for filtering by server). */
  nodeIds: string[];
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const isKeyTarget = (targetType: string): boolean =>
  targetType === "vpn_key" || targetType === "keys";

const eventKeyId = (event: AuditEvent): string | null => {
  if (isKeyTarget(event.targetType) && event.targetId) return event.targetId;
  if (event.action === "admin.users.create-key") {
    return asString(event.metadata?.keyId);
  }
  return null;
};

const extractFromMeta = (
  keyId: string,
  meta: Record<string, unknown> | null,
): AuditKeyContext => ({
  keyId,
  nodeId: asString(meta?.nodeId),
  endpointId: asString(meta?.endpointId),
  ownerId: asString(meta?.ownerId),
  deviceLabel: asString(meta?.deviceLabel),
  deviceType: asString(meta?.deviceType),
  keyNumber: asNumber(meta?.keyNumber),
  internalName: asString(meta?.internalName),
  protocol: asString(meta?.protocol),
  routeProfile: asString(meta?.routeProfile),
});

const mergeContext = (
  primary: Partial<AuditKeyContext>,
  fallback: Partial<AuditKeyContext>,
): AuditKeyContext => ({
  keyId: primary.keyId ?? fallback.keyId ?? "",
  nodeId: primary.nodeId ?? fallback.nodeId ?? null,
  endpointId: primary.endpointId ?? fallback.endpointId ?? null,
  endpointName: primary.endpointName ?? fallback.endpointName ?? null,
  ownerId: primary.ownerId ?? fallback.ownerId ?? null,
  deviceLabel: primary.deviceLabel ?? fallback.deviceLabel ?? null,
  deviceType: primary.deviceType ?? fallback.deviceType ?? null,
  keyNumber: primary.keyNumber ?? fallback.keyNumber ?? null,
  internalName: primary.internalName ?? fallback.internalName ?? null,
  protocol: primary.protocol ?? fallback.protocol ?? null,
  routeProfile: primary.routeProfile ?? fallback.routeProfile ?? null,
});

/**
 * Recover key identity fields from the audit log itself so events for a key
 * that was later purged still know its server, owner, device, protocol, and
 * route profile.
 */
export const collectKeyContextFromAudit = (
  audit: readonly AuditEvent[],
): Map<string, AuditKeyContext> => {
  const byKeyId = new Map<string, AuditKeyContext>();
  for (const event of audit) {
    const keyId = eventKeyId(event);
    if (!keyId || !event.metadata) continue;
    const extracted = extractFromMeta(keyId, event.metadata);
    const existing = byKeyId.get(keyId);
    byKeyId.set(keyId, existing ? mergeContext(existing, extracted) : extracted);
  }
  return byKeyId;
};

const DEVICE_LABEL_KEY: Record<string, string> = {
  android: "device.name.android",
  ios: "device.name.ios",
  macos: "device.name.macos",
  windows: "device.name.windows",
  linux: "device.name.linux",
  other: "device.other",
};

const ROUTE_LABEL_KEY: Record<string, string> = {
  full_tunnel: "route.full_tunnel",
  ru_blacklist: "route.ru_blacklist",
};

const PROTOCOL_LABEL_KEY: Record<string, string> = {
  awg2: "protocol.awg2",
  awg3: "protocol.awg3",
};

export const formatServerLabel = (
  node: Pick<AdminNode, "name" | "publicEndpoints"> | undefined,
  endpointId: string | null | undefined,
  endpointName: string | null | undefined,
): string | null => {
  if (!node) return null;
  const resolvedEndpoint =
    endpointName ??
    (endpointId
      ? node.publicEndpoints?.find((ep) => ep.id === endpointId)?.name ?? null
      : null);
  if (resolvedEndpoint && resolvedEndpoint !== node.name) {
    return `${node.name} · ${resolvedEndpoint}`;
  }
  return node.name;
};

/**
 * Resolve human-readable key & server details for one audit event, combining
 * live `keys`, event metadata, and historical snapshots recovered from the log.
 */
export const resolveAuditKeyDetails = ({
  event,
  keysById,
  logKeyContext,
  nodesById,
  personFor,
  t,
}: {
  event: AuditEvent;
  keysById: Map<string, AdminKey>;
  logKeyContext: Map<string, AuditKeyContext>;
  nodesById: Map<string, AdminNode>;
  personFor: (id: string | null) => AuditPerson | null;
  t: AuditTranslate;
}): ResolvedAuditKeyDetails => {
  const keyId = eventKeyId(event);
  const relatedNodeIds = new Set<string>();

  if (event.targetType === "node" && event.targetId) {
    relatedNodeIds.add(event.targetId);
  }
  const metaNodeId = asString(event.metadata?.nodeId);
  if (metaNodeId) relatedNodeIds.add(metaNodeId);
  if (Array.isArray(event.metadata?.nodeIds)) {
    for (const id of event.metadata.nodeIds) {
      const parsed = asString(id);
      if (parsed) relatedNodeIds.add(parsed);
    }
  }

  if (!keyId) {
    return {
      title: null,
      internalName: null,
      serverLabel: null,
      owner: null,
      deviceLabel: null,
      protocolLabel: null,
      routeLabel: null,
      nodeIds: [...relatedNodeIds],
    };
  }

  const live = keysById.get(keyId);
  const liveCtx: Partial<AuditKeyContext> = live
    ? {
        keyId: live.id,
        nodeId: live.nodeId,
        endpointId: live.endpointId ?? null,
        endpointName: live.endpointName ?? null,
        ownerId: live.ownerId,
        deviceLabel: live.deviceLabel || null,
        deviceType: live.deviceType || null,
        keyNumber: live.keyNumber ?? null,
        internalName: live.internalName ?? null,
        protocol: live.protocol || null,
        routeProfile: live.routeProfile || null,
      }
    : {};
  const metaCtx = extractFromMeta(keyId, event.metadata);
  const logCtx = logKeyContext.get(keyId) ?? {};
  // Prefer live key fields when the key still exists, then this event's own
  // metadata, then fields recovered from other audit rows for the same key.
  const merged = mergeContext(mergeContext(liveCtx, metaCtx), logCtx);

  if (merged.nodeId) relatedNodeIds.add(merged.nodeId);

  const node = merged.nodeId ? nodesById.get(merged.nodeId) : undefined;
  const serverLabel = formatServerLabel(node, merged.endpointId, merged.endpointName);

  const deviceTypeKey = merged.deviceType ? DEVICE_LABEL_KEY[merged.deviceType] : undefined;
  const deviceTypeLabel = deviceTypeKey ? t(deviceTypeKey) : null;

  const baseTitle = merged.deviceLabel || deviceTypeLabel;
  const numberSuffix =
    merged.keyNumber !== null && merged.keyNumber !== undefined
      ? `#${merged.keyNumber}`
      : null;
  const title =
    baseTitle && numberSuffix
      ? `${baseTitle} ${numberSuffix}`
      : baseTitle ?? numberSuffix ?? null;

  // Show the device type chip only when it adds information beyond the title.
  const deviceLabel =
    deviceTypeLabel &&
    (!merged.deviceLabel ||
      merged.deviceLabel.toLowerCase() !== deviceTypeLabel.toLowerCase())
      ? deviceTypeLabel
      : null;

  const owner =
    merged.ownerId && merged.ownerId !== event.actorUserId
      ? personFor(merged.ownerId)
      : null;

  const protocolKey = merged.protocol ? PROTOCOL_LABEL_KEY[merged.protocol] : undefined;
  const protocolLabel = protocolKey
    ? t(protocolKey)
    : merged.protocol ?? null;

  const routeKey = merged.routeProfile ? ROUTE_LABEL_KEY[merged.routeProfile] : undefined;
  const routeLabel = routeKey
    ? t(routeKey)
    : merged.routeProfile ?? null;

  return {
    title,
    internalName: merged.internalName ?? null,
    serverLabel,
    owner,
    deviceLabel,
    protocolLabel,
    routeLabel,
    nodeIds: [...relatedNodeIds],
  };
};

const KEY_DETAIL_META_KEYS = new Set([
  "ownerId",
  "nodeId",
  "endpointId",
  "deviceLabel",
  "deviceType",
  "keyNumber",
  "internalName",
  "protocol",
  "routeProfile",
  "nameDisplay",
  "nodeLabel",
  "keyId",
]);

const META_REFERENCE: Record<string, "user" | "node"> = {
  ownerId: "user",
  userId: "user",
  actorUserId: "user",
  targetUserId: "user",
  nodeId: "node",
};

const META_LABEL_KEY: Record<string, string> = {
  ownerId: "audit.meta.owner",
  userId: "audit.meta.user",
  nodeId: "audit.meta.server",
  nodeIds: "audit.meta.servers",
  protocol: "audit.meta.protocol",
  routeProfile: "audit.meta.profile",
  profile: "audit.meta.profile",
  deviceType: "audit.meta.device",
  keysQueuedForRevoke: "audit.meta.keysQueuedForRevoke",
  revokedKeys: "audit.meta.revokedKeys",
  affectedKeys: "audit.meta.affectedKeys",
  reissued: "audit.meta.reissued",
  revision: "audit.meta.revision",
  version: "audit.meta.version",
  pinned: "audit.meta.pinned",
  hasNote: "audit.meta.hasNote",
  bridgeMode: "audit.meta.bridgeMode",
  fields: "audit.meta.fields",
};

/**
 * Format remaining event metadata as clean human-readable pills, omitting
 * fields already rendered as structured key/server chips on key events.
 */
export const formatAuditMetaPills = ({
  event,
  hasKeyDetails,
  resolveReference,
  t,
}: {
  event: AuditEvent;
  hasKeyDetails: boolean;
  resolveReference: (kind: "user" | "node", id: string) => string | null;
  t: AuditTranslate;
}): string[] => {
  const metadata = event.metadata;
  if (!metadata) return [];

  const pills: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined || value === "") continue;
    if (hasKeyDetails && KEY_DETAIL_META_KEYS.has(key)) continue;
    if (key === "nameDisplay") continue;
    // Skip internal null/trivial fields like `vpnBridgeRouteId` when already
    // summarized or `hasNote: false`.
    if (key === "hasNote" && value === false) continue;

    const labelKey = META_LABEL_KEY[key];
    const label = labelKey ? t(labelKey) : key;

    if (key === "nodeIds" && Array.isArray(value)) {
      const names = value
        .map((id) =>
          typeof id === "string"
            ? (resolveReference("node", id) ?? id.slice(0, 8))
            : null,
        )
        .filter((name): name is string => Boolean(name));
      if (names.length > 0) {
        const joined = names.join(", ");
        pills.push(
          `${label}: ${joined.length > 48 ? `${joined.slice(0, 48)}…` : joined}`,
        );
      }
      continue;
    }

    const refKind = META_REFERENCE[key];
    if (refKind && typeof value === "string") {
      const resolved = resolveReference(refKind, value);
      if (resolved) {
        pills.push(`${label}: ${resolved}`);
        continue;
      }
    }

    if ((key === "profile" || key === "routeProfile") && typeof value === "string") {
      const routeKey = ROUTE_LABEL_KEY[value];
      pills.push(`${label}: ${routeKey ? t(routeKey) : value}`);
      continue;
    }

    if (key === "protocol" && typeof value === "string") {
      const protoKey = PROTOCOL_LABEL_KEY[value];
      pills.push(`${label}: ${protoKey ? t(protoKey) : value}`);
      continue;
    }

    if (key === "deviceType" && typeof value === "string") {
      const devKey = DEVICE_LABEL_KEY[value];
      pills.push(`${label}: ${devKey ? t(devKey) : value}`);
      continue;
    }

    if (typeof value === "boolean") {
      pills.push(`${label}: ${value ? t("audit.meta.yes") : t("audit.meta.no")}`);
      continue;
    }

    if (key === "version" && typeof value === "string" && value.length > 12) {
      pills.push(`${label}: ${value.slice(0, 12)}`);
      continue;
    }

    const rendered =
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : Array.isArray(value)
          ? value.map((item) => String(item)).join(", ")
          : JSON.stringify(value);
    pills.push(
      `${label}: ${rendered.length > 40 ? `${rendered.slice(0, 40)}…` : rendered}`,
    );

    if (pills.length >= 5) break;
  }

  return pills;
};

"use client";

import * as React from "react";
import {
  Cable,
  ChevronDown,
  Download,
  RefreshCw,
  Server,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import type {
  Bridge,
  BridgeEligibility,
  BridgeRouteSummary,
  InfrastructureBridgeItem,
  InfrastructureVpnItem,
  NodeBridgeRoute,
  NodeBridgeRoutes,
} from "@amnezia/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Callout, Hint } from "@/components/ui/hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BridgeRouteFacts } from "@/components/admin/bridge-route-view";
import { CommandBlock } from "@/components/admin/command-block";
import { useAdminData } from "@/components/admin/admin-data";
import {
  fetchTestConfig,
  getEligibility,
  getNodeRoutes,
  listInfrastructure,
  prepareRoute,
  releaseRoute,
  setNodeEndpoint,
  verifyRouteByOperator,
  verifyRouteByProbe,
  type Requester,
} from "@/lib/bridge-api";
import {
  bridgeEntry,
  bridgeNeedsHostSetup,
  describeBridgeError,
  registrationTone,
  verificationLabelKey,
  verificationTone,
} from "@/lib/bridge-ui";
import { ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { KeyView } from "@/lib/types";

const DIRECT_VALUE = "direct";
const bridgeOptionValue = (bridgeId: string): string => `bridge:${bridgeId}`;

type ProbeUnavailableCode =
  | "BRIDGE_PROBE_UNAVAILABLE"
  | "BRIDGE_PROBE_CAPABILITY_MISSING"
  | "BRIDGE_JOBS_DISABLED";

type Notice = { tone: "danger" | "success" | "warning" | "info"; text: string };

export async function saveRouteAssignment(
  request: Requester,
  nodeId: string,
  routeId: string | null,
  revision: number,
  registrationMarker?: string,
) {
  if (routeId !== null && registrationMarker !== undefined) {
    await verifyRouteByOperator(request, routeId, registrationMarker);
  }
  return setNodeEndpoint(request, nodeId, routeId, revision);
}

/**
 * Sorts VPN servers in the admin's `nodeOrder` (mirroring `NodeOrderList`),
 * with unordered servers trailing alphabetically by name.
 */
function orderVpnItems(
  items: readonly InfrastructureVpnItem[],
  nodeOrder: readonly string[],
): InfrastructureVpnItem[] {
  const rank = new Map(nodeOrder.map((id, idx) => [id, idx]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Per-node route editor: lists every VPN server with a bridge dropdown right
 * across from it (modeled after `NodeOrderList` / `NodeSelect`), plus an inline
 * expandable panel per server for route preparation, verification, eligibility
 * and retiring-route cleanup.
 */
export function NodeRoutesEditor({ initialNodeId }: { initialNodeId: string | null }) {
  const { t } = useT();
  const { nodes, policy, request, reload: reloadAdmin } = useAdminData();
  const [expandedNodeId, setExpandedNodeId] = React.useState<string | null>(initialNodeId);
  const expandedNodeIdRef = React.useRef<string | null>(initialNodeId);
  const detailRequestSeqRef = React.useRef(0);
  const [vpnItems, setVpnItems] = React.useState<InfrastructureVpnItem[]>([]);
  const [bridges, setBridges] = React.useState<InfrastructureBridgeItem[]>([]);
  const [infraLoading, setInfraLoading] = React.useState(false);

  const [routes, setRoutes] = React.useState<NodeBridgeRoutes | null>(null);
  const [eligibility, setEligibility] = React.useState<BridgeEligibility | null>(null);
  const [testKeys, setTestKeys] = React.useState<KeyView[]>([]);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);

  const selectExpandedNode = React.useCallback((nextId: string | null) => {
    expandedNodeIdRef.current = nextId;
    setExpandedNodeId(nextId);
  }, []);

  // Follow `?node=<id>` when arriving from `/admin/nodes`.
  React.useEffect(() => {
    if (initialNodeId) selectExpandedNode(initialNodeId);
  }, [initialNodeId, selectExpandedNode]);

  const loadOverview = React.useCallback(async () => {
    setInfraLoading(true);
    try {
      const items = await listInfrastructure(request);
      setVpnItems(
        items.filter((item): item is InfrastructureVpnItem => item.kind === "vpn"),
      );
      setBridges(
        items.filter(
          (item): item is InfrastructureBridgeItem => item.kind === "bridge",
        ),
      );
    } catch (cause) {
      setNotice({ tone: "danger", text: describeBridgeError(cause, t).message });
    } finally {
      setInfraLoading(false);
    }
  }, [request, t]);

  React.useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const loadDetails = React.useCallback(
    async (id: string) => {
      const seq = ++detailRequestSeqRef.current;
      setDetailLoading(true);
      try {
        const [nextRoutes, nextEligibility, keys] = await Promise.all([
          getNodeRoutes(request, id),
          getEligibility(request, id),
          request<KeyView[]>("/api/keys"),
        ]);
        if (seq !== detailRequestSeqRef.current) return;
        setRoutes(nextRoutes);
        setEligibility(nextEligibility);
        setTestKeys(
          keys.filter(
            (key) => key.nodeId === id && key.protocol === "awg3" && key.state === "active",
          ),
        );
      } catch (cause) {
        if (seq !== detailRequestSeqRef.current) return;
        setNotice({ tone: "danger", text: describeBridgeError(cause, t).message });
      } finally {
        if (seq === detailRequestSeqRef.current) setDetailLoading(false);
      }
    },
    [request, t],
  );

  React.useEffect(() => {
    detailRequestSeqRef.current += 1;
    setRoutes(null);
    setEligibility(null);
    if (expandedNodeId) void loadDetails(expandedNodeId);
  }, [expandedNodeId, loadDetails]);

  const refreshAll = React.useCallback(
    async (detailNodeId: string | null = expandedNodeIdRef.current) => {
      await Promise.all([
        loadOverview(),
        detailNodeId ? loadDetails(detailNodeId) : Promise.resolve(),
      ]);
    },
    [loadOverview, loadDetails],
  );

  const runForNode = async (
    targetNodeId: string,
    name: string,
    action: () => Promise<string | void>,
    refetchOnError = false,
  ) => {
    setBusy(name);
    setNotice(null);
    try {
      const done = await action();
      if (done) {
        setNotice({ tone: "success", text: done });
        toast.success(done);
      }
      await refreshAll(expandedNodeIdRef.current ?? targetNodeId);
    } catch (cause) {
      const described = describeBridgeError(cause, t);
      setNotice({ tone: "danger", text: described.message });
      toast.error(described.message);
      if (described.refetch || refetchOnError) {
        await refreshAll(expandedNodeIdRef.current);
      }
    } finally {
      setBusy(null);
    }
  };

  const activate = (
    targetNodeId: string,
    routeId: string | null,
    targetRevision: number,
    registrationMarker?: string,
  ) =>
    runForNode(
      targetNodeId,
      `${targetNodeId}-${routeId ?? "direct"}`,
      async () => {
        const result = await saveRouteAssignment(
          request,
          targetNodeId,
          routeId,
          targetRevision,
          registrationMarker,
        );
        await reloadAdmin();
        if (!result.vpnEndpoint.changed) return t("bridge.unchanged");
        return t(routeId ? "bridge.activated" : "bridge.switchedDirect");
      },
      // Verification may already be recorded when activation fails.
      registrationMarker !== undefined,
    );

  // Merge infrastructure VPN items with admin node list so servers show even
  // while infrastructure loads for the first time.
  const orderedServers = React.useMemo(() => {
    if (vpnItems.length > 0) {
      return orderVpnItems(vpnItems, policy.nodeOrder ?? []);
    }
    return orderVpnItems(
      nodes.map((node) => ({
        kind: "vpn" as const,
        id: node.id,
        name: node.name,
        publicName: node.publicName ?? null,
        enabled: node.enabled,
        activeRoute: null,
        vpnEndpointRevision: 0,
      })),
      policy.nodeOrder ?? [],
    );
  }, [vpnItems, nodes, policy.nodeOrder]);

  const routeByNodeAndBridge = React.useMemo(() => {
    const map = new Map<string, { bridge: InfrastructureBridgeItem; route: BridgeRouteSummary }>();
    for (const bridge of bridges) {
      for (const route of bridge.routes) {
        map.set(`${route.nodeId}:${bridge.id}`, { bridge, route });
      }
    }
    return map;
  }, [bridges]);

  const nonActiveCountsByNode = React.useMemo(() => {
    const map = new Map<string, { drafts: number; retiring: number }>();
    for (const bridge of bridges) {
      for (const route of bridge.routes) {
        if (route.state === "active") continue;
        const entry = map.get(route.nodeId) ?? { drafts: 0, retiring: 0 };
        if (route.state === "draft") entry.drafts += 1;
        else entry.retiring += 1;
        map.set(route.nodeId, entry);
      }
    }
    return map;
  }, [bridges]);

  const handleQuickSelect = (server: InfrastructureVpnItem, nextValue: string) => {
    if (nextValue === DIRECT_VALUE) {
      if (!server.activeRoute) return;
      void activate(server.id, null, server.vpnEndpointRevision);
      return;
    }
    if (!nextValue.startsWith("bridge:")) return;
    const bridgeId = nextValue.slice("bridge:".length);
    const existing = routeByNodeAndBridge.get(`${server.id}:${bridgeId}`);
    if (existing) {
      if (existing.route.state === "active") return;
      const isVerified =
        existing.route.verification.kind === "candidate" &&
        existing.route.verification.status === "valid";
      if (isVerified) {
        void activate(server.id, existing.route.id, server.vpnEndpointRevision);
        return;
      }
      // Route exists (draft or retiring) but needs setup or verification:
      // expand the server's inline panel right beneath it.
      selectExpandedNode(server.id);
      setNotice({ tone: "info", text: t("bridge.needsVerifyHint") });
      return;
    }
    // No route exists yet for (server, bridge): prepare it automatically and
    // open the server's inline panel with setup commands & verification tools.
    selectExpandedNode(server.id);
    void runForNode(server.id, `prepare-${server.id}`, async () => {
      const result = await prepareRoute(request, server.id, bridgeId);
      return result.created ? t("bridge.prepared") : t("bridge.preparedExisting");
    });
  };

  return (
    <Card id="node-routes">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Cable className="h-4 w-4 text-primary" />
            {t("bridge.routesTitle")}
            <Hint>{t("bridge.routesHint")}</Hint>
          </CardTitle>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={infraLoading || detailLoading || busy !== null}
            onClick={() => void refreshAll(expandedNodeId)}
          >
            <RefreshCw className={cn("h-4 w-4", infraLoading && "animate-spin")} />
            {t("bridge.refresh")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t("bridge.serverListHint")} {t("bridge.awg31Only")}
        </p>

        {notice ? (
          <Callout
            tone={notice.tone}
            icon={notice.tone === "danger" ? <TriangleAlert className="h-4 w-4" /> : undefined}
          >
            {notice.text}
          </Callout>
        ) : null}

        {orderedServers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("bridge.noNodes")}</p>
        ) : (
          <ol className="space-y-1.5 rounded-lg border border-border/60 bg-well p-1.5 shadow-[var(--inset-shadow)]">
            {orderedServers.map((server) => {
              const activeBridge = server.activeRoute
                ? bridges.find((bridge) => bridge.id === server.activeRoute?.bridgeId) ?? null
                : null;
              const currentSelectValue = server.activeRoute
                ? bridgeOptionValue(server.activeRoute.bridgeId)
                : DIRECT_VALUE;
              const expanded = expandedNodeId === server.id;
              const pending = nonActiveCountsByNode.get(server.id);
              const detailRoutes =
                expanded && routes?.nodeId === server.id ? routes : null;
              const detailEligibility =
                expanded && eligibility?.nodeId === server.id ? eligibility : null;

              return (
                <li
                  key={server.id}
                  className={cn(
                    "rounded-md border bg-card shadow-xs transition-colors",
                    expanded ? "border-primary/40" : "border-border/70",
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2.5 px-3 py-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[image:var(--tile-gradient-soft)] text-primary/80 ring-1 ring-primary/10">
                        <Server className="size-3.5" />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-medium">
                            {server.name}
                          </span>
                          {server.publicName && server.publicName !== server.name ? (
                            <span className="truncate text-xs text-muted-foreground">
                              ({server.publicName})
                            </span>
                          ) : null}
                          {server.activeRoute && activeBridge ? (
                            <Badge variant="success" className="font-mono text-[11px]">
                              {bridgeEntry(
                                activeBridge.publicIpv4,
                                server.activeRoute.publicUdpPort,
                              )}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[11px]">
                              {t("bridge.direct")}
                            </Badge>
                          )}
                          {pending && pending.drafts > 0 ? (
                            <Badge variant="warning" className="text-[11px]">
                              {t("keyBridge.routeDraft")}
                            </Badge>
                          ) : null}
                          {pending && pending.retiring > 0 ? (
                            <Badge variant="outline" className="text-[11px]">
                              {t("keyBridge.routeRetiring")}
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div className="flex w-full items-center gap-1.5 sm:w-auto">
                      <Select
                        value={currentSelectValue}
                        disabled={busy !== null || infraLoading}
                        onValueChange={(value) => handleQuickSelect(server, value)}
                      >
                        <SelectTrigger
                          aria-label={`${server.name} — ${t("bridge.routesTitle")}`}
                          className="h-8 min-w-0 flex-1 sm:w-64"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={DIRECT_VALUE}>
                            {t("bridge.dropdownDirect")}
                          </SelectItem>
                          {bridges.map((bridge) => {
                            const existing = routeByNodeAndBridge.get(
                              `${server.id}:${bridge.id}`,
                            )?.route;
                            const label = !existing
                              ? t("bridge.dropdownBridgePrepare", {
                                  name: bridge.name,
                                  free: Math.max(0, bridge.capacity - bridge.heldPorts),
                                })
                              : existing.state === "active"
                                ? t("bridge.dropdownBridgeActive", {
                                    name: bridge.name,
                                    port: existing.publicUdpPort,
                                  })
                                : existing.verification.kind === "candidate" &&
                                    existing.verification.status === "valid"
                                  ? t("bridge.dropdownBridgeReady", {
                                      name: bridge.name,
                                      port: existing.publicUdpPort,
                                    })
                                  : existing.state === "draft"
                                    ? t("bridge.dropdownBridgeDraft", {
                                        name: bridge.name,
                                        port: existing.publicUdpPort,
                                      })
                                    : t("bridge.dropdownBridgeRetiring", {
                                        name: bridge.name,
                                        port: existing.publicUdpPort,
                                      });
                            return (
                              <SelectItem
                                key={bridge.id}
                                value={bridgeOptionValue(bridge.id)}
                              >
                                {label}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>

                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-expanded={expanded}
                        aria-label={
                          expanded
                            ? t("bridge.collapseDetails")
                            : t("bridge.expandDetails")
                        }
                        title={
                          expanded
                            ? t("bridge.collapseDetails")
                            : t("bridge.expandDetails")
                        }
                        onClick={() =>
                          selectExpandedNode(expanded ? null : server.id)
                        }
                      >
                        <ChevronDown
                          className={cn(
                            "h-4 w-4 text-muted-foreground transition-transform",
                            expanded && "rotate-180 text-foreground",
                          )}
                        />
                      </Button>
                    </div>
                  </div>

                  {expanded ? (
                    <div className="space-y-3 border-t border-border/60 bg-well/40 p-3">
                      {!detailRoutes ? (
                        <p className="text-sm text-muted-foreground">
                          {detailLoading ? t("bridge.loading") : t("bridge.loadFailed")}
                        </p>
                      ) : (
                        <>
                          <CurrentAssignment
                            routes={detailRoutes}
                            busy={busy}
                            loading={detailLoading}
                            onDirect={() =>
                              void activate(
                                server.id,
                                null,
                                detailRoutes.vpnEndpointRevision,
                              )
                            }
                            onRefresh={() => void refreshAll(server.id)}
                          />

                          {detailRoutes.drafts.map((route) => (
                            <CandidateRoute
                              key={route.id}
                              route={route}
                              bridge={
                                bridges.find((bridge) => bridge.id === route.bridgeId) ??
                                null
                              }
                              testKeys={testKeys}
                              busy={busy}
                              loading={detailLoading}
                              onRefresh={() => void refreshAll(server.id)}
                              request={request}
                              onRun={(name, action) =>
                                runForNode(server.id, name, action)
                              }
                              onActivate={(marker) =>
                                void activate(
                                  server.id,
                                  route.id,
                                  detailRoutes.vpnEndpointRevision,
                                  marker,
                                )
                              }
                            />
                          ))}

                          {detailEligibility ? (
                            <EligibilityView eligibility={detailEligibility} />
                          ) : null}

                          <PrepareForm
                            bridges={bridges}
                            busy={busy === `prepare-${server.id}`}
                            onPrepare={(bridgeId, port) =>
                              void runForNode(
                                server.id,
                                `prepare-${server.id}`,
                                async () => {
                                  const result = await prepareRoute(
                                    request,
                                    server.id,
                                    bridgeId,
                                    port,
                                  );
                                  return result.created
                                    ? t("bridge.prepared")
                                    : t("bridge.preparedExisting");
                                },
                              )
                            }
                          />

                          {detailRoutes.retiring.map((route) => (
                            <CandidateRoute
                              key={route.id}
                              route={route}
                              bridge={
                                bridges.find((bridge) => bridge.id === route.bridgeId) ??
                                null
                              }
                              testKeys={testKeys}
                              busy={busy}
                              loading={detailLoading}
                              onRefresh={() => void refreshAll(server.id)}
                              request={request}
                              onRun={(name, action) =>
                                runForNode(server.id, name, action)
                              }
                              onActivate={(marker) =>
                                void activate(
                                  server.id,
                                  route.id,
                                  detailRoutes.vpnEndpointRevision,
                                  marker,
                                )
                              }
                            />
                          ))}
                        </>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function CurrentAssignment({
  routes,
  busy,
  loading,
  onDirect,
  onRefresh,
}: {
  routes: NodeBridgeRoutes;
  busy: string | null;
  loading: boolean;
  onDirect: () => void;
  onRefresh: () => void;
}) {
  const { t, lang } = useT();
  const active = routes.activeRoute;
  return (
    <section className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">{t("bridge.current")}</h4>
        <Badge variant={active ? "success" : "outline"}>
          {active
            ? bridgeEntry(active.bridgePublicIpv4, active.publicUdpPort)
            : t("bridge.direct")}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {t("bridge.revision", { revision: routes.vpnEndpointRevision })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw className="h-4 w-4" /> {t("bridge.refresh")}
        </Button>
      </div>
      {active ? (
        <>
          <BridgeRouteFacts route={active} t={t} lang={lang} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={onDirect}
          >
            {t("bridge.useDirect")}
          </Button>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t("bridge.directHint")}</p>
      )}
    </section>
  );
}

function EligibilityView({ eligibility }: { eligibility: BridgeEligibility }) {
  const { t } = useT();
  return (
    <details className="rounded-lg border bg-card px-3 py-2" open={eligibility.unsupported > 0}>
      <summary className="cursor-pointer text-sm font-medium">{t("bridge.eligibility")}</summary>
      <p className="mt-2 text-xs text-muted-foreground">{t("bridge.eligibilityHint")}</p>
      <ul className="mt-1.5 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
        <li>{t("bridge.elig.awg31", { count: eligibility.awg31Eligible })}</li>
        <li>{t("bridge.elig.awg20", { count: eligibility.awg20Direct })}</li>
        <li>{t("bridge.elig.awg2", { count: eligibility.awg2NativeDirect })}</li>
        <li className={eligibility.unsupported > 0 ? "font-medium text-destructive" : undefined}>
          {t("bridge.elig.unsupported", { count: eligibility.unsupported })}
        </li>
      </ul>
      {eligibility.unsupported > 0 ? (
        <p className="text-xs text-destructive">{t("bridge.elig.blocked")}</p>
      ) : null}
      {eligibility.unsupportedKeyIds.length > 0 ? (
        <p className="break-all font-mono text-xs text-muted-foreground">
          {t("bridge.elig.unsupportedIds", { ids: eligibility.unsupportedKeyIds.join(", ") })}
        </p>
      ) : null}
    </details>
  );
}

function PrepareForm({
  bridges,
  busy,
  onPrepare,
}: {
  bridges: Bridge[];
  busy: boolean;
  onPrepare: (bridgeId: string, port: number | undefined) => void;
}) {
  const { t } = useT();
  const [bridgeId, setBridgeId] = React.useState("");
  const [port, setPort] = React.useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!bridgeId) return;
    onPrepare(bridgeId, port.trim() === "" ? undefined : Number(port));
    setPort("");
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-2 rounded-lg border bg-card p-3"
      aria-label={t("bridge.prepareTitle")}
    >
      <h4 className="text-sm font-semibold">{t("bridge.prepareTitle")}</h4>
      {bridges.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("bridge.noBridgesYet")}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="route-bridge">{t("bridge.chooseBridge")}</Label>
              <Select value={bridgeId} onValueChange={setBridgeId} required>
                <SelectTrigger id="route-bridge">
                  <SelectValue placeholder={t("bridge.chooseBridgePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {bridges.map((bridge) => (
                    <SelectItem key={bridge.id} value={bridge.id}>
                      {bridge.name} · {bridge.publicIpv4} ·{" "}
                      {t("bridge.freePorts", {
                        free: Math.max(0, bridge.capacity - bridge.heldPorts),
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={busy || !bridgeId}>
              {t("bridge.prepare")}
            </Button>
          </div>
          <details>
            <summary className="cursor-pointer text-xs font-medium">{t("bridge.prepareOptions")}</summary>
            <div className="mt-2 space-y-1.5 sm:max-w-40">
              <Label htmlFor="route-port">{t("bridge.portOverride")}</Label>
              <Input
                id="route-port"
                type="number"
                min={1}
                max={65535}
                placeholder={t("bridge.portAuto")}
                value={port}
                onChange={(event) => setPort(event.target.value)}
                onInvalid={(event) => {
                  const options = event.currentTarget.closest("details");
                  if (options) options.open = true;
                }}
              />
            </div>
          </details>
        </>
      )}
    </form>
  );
}

export function operatorRegistration(
  registration: NodeBridgeRoute["registration"],
  downloadedMarker: string | null | undefined,
  markerInput: string | null,
) {
  const registered = registration.status === "online" && Boolean(registration.marker);
  const defaultMarker = downloadedMarker === undefined ? registration.marker : downloadedMarker;
  const marker = markerInput ?? defaultMarker ?? "";
  return {
    registered,
    marker,
    markerMatches: registered && marker.trim() === registration.marker,
    testNeedsRefresh: downloadedMarker !== undefined && downloadedMarker !== registration.marker,
  };
}

export function CandidateRoute({
  route,
  bridge,
  testKeys,
  busy,
  loading,
  request,
  onRun,
  onActivate,
  onRefresh,
}: {
  route: NodeBridgeRoute;
  bridge: Bridge | null;
  testKeys: KeyView[];
  busy: string | null;
  loading: boolean;
  request: Requester;
  onRun: (name: string, action: () => Promise<string | void>) => Promise<void>;
  onActivate: (registrationMarker?: string) => void;
  onRefresh: () => void;
}) {
  const { t, lang } = useT();
  const [downloadedMarker, setDownloadedMarker] = React.useState<string | null>();
  const [markerInput, setMarkerInput] = React.useState<string | null>(null);
  const [confirmedMarker, setConfirmedMarker] = React.useState<string | null>(null);
  const [selectedKeyId, setSelectedKeyId] = React.useState("");
  const [releasing, setReleasing] = React.useState(false);
  const [probeUnavailable, setProbeUnavailable] = React.useState<ProbeUnavailableCode | null>(null);
  const disabled = busy !== null || loading;
  const retiring = route.state === "retiring";
  const { registration, verification } = route;
  const { registered, marker, markerMatches, testNeedsRefresh } = operatorRegistration(
    registration,
    downloadedMarker,
    markerInput,
  );
  const verified = verification.kind === "candidate" && verification.status === "valid";
  const confirmed = markerMatches && confirmedMarker === registration.marker;
  const keyId = testKeys.find((key) => key.id === selectedKeyId)?.id ?? testKeys[0]?.id ?? "";

  const downloadTest = () =>
    onRun(`test-${route.id}`, async () => {
      const config = await fetchTestConfig(route.id, keyId);
      const url = URL.createObjectURL(config.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = config.filename;
      link.click();
      URL.revokeObjectURL(url);
      setDownloadedMarker(config.marker);
      setMarkerInput(null);
      setConfirmedMarker(null);
      return config.marker ? t("bridge.testDownloaded") : t("bridge.testDownloadedNoMarker");
    });

  const verifyWithProbe = () =>
    onRun(`probe-${route.id}`, async () => {
      setProbeUnavailable(null);
      try {
        const result = await verifyRouteByProbe(request, route.id);
        if (result.method === "probe") return t(`bridge.probe.${result.status}`);
      } catch (cause) {
        if (
          cause instanceof ApiClientError &&
          (cause.code === "BRIDGE_PROBE_UNAVAILABLE" ||
            cause.code === "BRIDGE_PROBE_CAPABILITY_MISSING" ||
            cause.code === "BRIDGE_JOBS_DISABLED")
        ) {
          setProbeUnavailable(cause.code);
          return;
        }
        throw cause;
      }
    });

  const setupNeeded = !retiring && !registered;
  const nodeSetup = route.setupCommands ? (
    <div className="space-y-2">
      <p className="text-xs font-medium">{t("bridge.nodeSetup")}</p>
      <p className="text-xs text-muted-foreground">
        {t("bridge.nodeSetupCredentials")}{" "}
        <code className="break-all">/etc/amnezia-node/frp/{route.bridgeId}/</code>.
      </p>
      <CommandBlock label={t("bridge.dryRunCommand")} command={route.setupCommands.dryRun} />
      <CommandBlock label={t("bridge.installCommand")} command={route.setupCommands.install} />
      {route.setupCommands.checkTls ? (
        <CommandBlock label={t("bridge.checkTlsCommand")} command={route.setupCommands.checkTls} />
      ) : null}
    </div>
  ) : null;
  const bridgeSetup = bridge && bridgeNeedsHostSetup(bridge) ? bridge.setupCommands : null;

  return (
    <section className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="text-sm font-semibold">
          {retiring ? t("bridge.retiringRoute") : t("bridge.candidateRoute")}
        </h4>
        <span className="text-xs text-muted-foreground">{route.bridgeName}</span>
        <span className="break-all font-mono text-xs">
          {bridgeEntry(route.bridgePublicIpv4, route.publicUdpPort)}/udp
        </span>
        <Badge variant={registrationTone(registration.status)}>
          {t(`bridge.obs.${registration.status}`)}
        </Badge>
        {registered ? (
          <Badge variant={verificationTone(verification)}>{t(verificationLabelKey(verification))}</Badge>
        ) : null}
      </div>

      {!registered ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {t(retiring ? "bridge.retiringRegistrationRequired" : "bridge.draftRegistrationRequired")}
          </p>
          {setupNeeded && bridgeSetup ? (
            <div className="space-y-2">
              <p className="text-xs font-medium">{t("bridge.hostSetupFirst")}</p>
              <CommandBlock label={t("bridge.dryRunCommand")} command={bridgeSetup.dryRun} />
              <CommandBlock label={t("bridge.installCommand")} command={bridgeSetup.install} />
            </div>
          ) : null}
          {setupNeeded ? nodeSetup : null}
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onRefresh}>
            <RefreshCw className="h-4 w-4" /> {t("bridge.refreshRegistration")}
          </Button>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled || (!verified && !confirmed)) return;
            setConfirmedMarker(null);
            onActivate(verified ? undefined : marker.trim());
          }}
        >
          {!verified ? (
            <div className="space-y-1">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={confirmed}
                  disabled={disabled || !markerMatches}
                  aria-describedby={`verify-hint-${route.id}`}
                  onChange={(event) => setConfirmedMarker(event.target.checked ? registration.marker : null)}
                />
                <span>{t("bridge.operatorConfirm")}</span>
              </label>
              <p
                id={`verify-hint-${route.id}`}
                className="text-xs text-muted-foreground"
                role={!markerMatches ? "status" : undefined}
              >
                {t(markerMatches
                  ? "bridge.operatorConfirmHint"
                  : testNeedsRefresh
                    ? "bridge.testRegistrationChanged"
                    : "bridge.operatorMarkerMismatch")}
              </p>
            </div>
          ) : null}
          <Button type="submit" disabled={disabled || (!verified && !confirmed)}>
            {t(verified ? "bridge.activate" : "bridge.confirmAndActivate")}
          </Button>

          <details className="rounded-md border px-2 py-1.5">
            <summary className="cursor-pointer text-xs font-medium">{t("bridge.verificationTools")}</summary>
            <div className="mt-2 space-y-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => void verifyWithProbe()}
              >
                {t("bridge.verifyProbe")}
              </Button>
              {probeUnavailable ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {t(`bridge.err.${probeUnavailable}`)}
                </p>
              ) : null}
              {testKeys.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("bridge.testConfigNoKey")}</p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={keyId} onValueChange={setSelectedKeyId} disabled={disabled}>
                    <SelectTrigger aria-label={t("bridge.testKey")} className="min-w-0 sm:w-auto">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {testKeys.map((key) => (
                        <SelectItem key={key.id} value={key.id}>
                          {key.deviceLabel || key.deviceType} · {key.id.slice(0, 8)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled || !keyId}
                    onClick={() => void downloadTest()}
                  >
                    <Download className="h-4 w-4" /> {t("bridge.testDownload")}
                  </Button>
                  <p className="basis-full text-xs text-muted-foreground">{t("bridge.testKeyIsolationHint")}</p>
                </div>
              )}
              {!verified ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`marker-${route.id}`}>{t("bridge.marker")}</Label>
                  <Input
                    id={`marker-${route.id}`}
                    className="font-mono"
                    autoComplete="off"
                    disabled={disabled}
                    value={marker}
                    onChange={(event) => {
                      setMarkerInput(event.target.value);
                      setConfirmedMarker(null);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">{t("bridge.operatorMarkerHint")}</p>
                </div>
              ) : null}
            </div>
          </details>
        </form>
      )}

      <details className="rounded-md border px-2 py-1.5">
        <summary className="cursor-pointer text-xs font-medium">{t("bridge.routeDetails")}</summary>
        <div className="mt-2 space-y-2">
          <BridgeRouteFacts route={route} t={t} lang={lang} />
          {!setupNeeded ? nodeSetup : null}
          {!retiring ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => setReleasing(true)}
            >
              {t("bridge.cancelDraft")}
            </Button>
          ) : null}
        </div>
      </details>

      {retiring ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => setReleasing(true)}
        >
          {t("bridge.releaseRetiring")}
        </Button>
      ) : null}

      <Dialog open={releasing} onOpenChange={setReleasing}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("bridge.releaseTitle")}</DialogTitle>
            <DialogDescription>
              {t("bridge.releaseDesc", {
                entry: bridgeEntry(route.bridgePublicIpv4, route.publicUdpPort),
              })}
            </DialogDescription>
          </DialogHeader>
          {route.setupCommands ? (
            <CommandBlock
              label={t("bridge.removeCommand")}
              command={route.setupCommands.remove}
            />
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setReleasing(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                setReleasing(false);
                void onRun(`release-${route.id}`, async () => {
                  await releaseRoute(request, route.id);
                  return t("bridge.released");
                });
              }}
            >
              {t("bridge.releaseConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

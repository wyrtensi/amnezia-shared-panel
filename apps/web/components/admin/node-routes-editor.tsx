"use client";

import * as React from "react";
import { Cable, Download, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type {
  Bridge,
  BridgeEligibility,
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
  listBridges,
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
import { useT } from "@/lib/i18n/provider";
import type { KeyView } from "@/lib/types";

const NO_NODE = "none";

type ProbeUnavailableCode =
  | "BRIDGE_PROBE_UNAVAILABLE"
  | "BRIDGE_PROBE_CAPABILITY_MISSING"
  | "BRIDGE_JOBS_DISABLED";

type Notice = { tone: "danger" | "success" | "warning"; text: string };

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
 * Per-node route editor: Direct or a bridge route, drafts and retiring routes.
 * Every state change goes through the Control API, which owns the rules; this
 * component loads the assignment, sends the revision it loaded, and shows the
 * API's error codes as readable messages.
 */
export function NodeRoutesEditor({ initialNodeId }: { initialNodeId: string | null }) {
  const { t } = useT();
  const { nodes, request, reload: reloadAdmin } = useAdminData();
  const [nodeId, setNodeId] = React.useState<string | null>(initialNodeId);
  const [routes, setRoutes] = React.useState<NodeBridgeRoutes | null>(null);
  const [bridges, setBridges] = React.useState<Bridge[]>([]);
  const [eligibility, setEligibility] = React.useState<BridgeEligibility | null>(null);
  const [testKeys, setTestKeys] = React.useState<KeyView[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);

  // The query param can arrive after the admin data does; follow it until the
  // operator picks a node by hand.
  React.useEffect(() => {
    if (initialNodeId) setNodeId(initialNodeId);
  }, [initialNodeId]);

  const load = React.useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        const [nextRoutes, nextBridges, nextEligibility, keys] = await Promise.all([
          getNodeRoutes(request, id),
          listBridges(request),
          getEligibility(request, id),
          request<KeyView[]>("/api/keys"),
        ]);
        setRoutes(nextRoutes);
        setBridges(nextBridges);
        setEligibility(nextEligibility);
        setTestKeys(
          keys.filter(
            (key) => key.nodeId === id && key.protocol === "awg3" && key.state === "active",
          ),
        );
      } catch (cause) {
        setNotice({ tone: "danger", text: describeBridgeError(cause, t).message });
      } finally {
        setLoading(false);
      }
    },
    [request, t],
  );

  React.useEffect(() => {
    setRoutes(null);
    setEligibility(null);
    setNotice(null);
    if (nodeId) void load(nodeId);
  }, [nodeId, load]);

  const run = async (
    name: string,
    action: () => Promise<string | void>,
    refetchOnError = false,
  ) => {
    if (!nodeId) return;
    setBusy(name);
    setNotice(null);
    try {
      const done = await action();
      if (done) {
        setNotice({ tone: "success", text: done });
        toast.success(done);
      }
      await load(nodeId);
    } catch (cause) {
      const described = describeBridgeError(cause, t);
      setNotice({ tone: "danger", text: described.message });
      toast.error(described.message);
      if (described.refetch || refetchOnError) await load(nodeId);
    } finally {
      setBusy(null);
    }
  };

  const revision = routes?.vpnEndpointRevision ?? 0;

  const activate = (routeId: string | null, registrationMarker?: string) => {
    if (!nodeId) return;
    return run(
      routeId ?? "direct",
      async () => {
        const result = await saveRouteAssignment(request, nodeId, routeId, revision, registrationMarker);
        await reloadAdmin();
        if (!result.vpnEndpoint.changed) return t("bridge.unchanged");
        return t(routeId ? "bridge.activated" : "bridge.switchedDirect");
      },
      // Verification may already be recorded when activation fails.
      registrationMarker !== undefined,
    );
  };

  return (
    <Card id="node-routes">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cable className="h-4 w-4 text-primary" />
          {t("bridge.routesTitle")}
          <Hint>{t("bridge.routesHint")}</Hint>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Callout tone="info">{t("bridge.awg31Only")}</Callout>

        <div className="space-y-1.5">
          <Label htmlFor="route-node">{t("bridge.selectNode")}</Label>
          <Select
            value={nodeId ?? ""}
            disabled={busy !== null}
            onValueChange={(value) => setNodeId(value === NO_NODE ? null : value)}
          >
            <SelectTrigger id="route-node" className="sm:max-w-sm">
              <SelectValue placeholder={t("bridge.selectNodePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_NODE}>{t("bridge.selectNodePlaceholder")}</SelectItem>
              {nodes.map((node) => (
                <SelectItem key={node.id} value={node.id}>
                  {node.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {notice ? (
          <Callout
            tone={notice.tone}
            icon={notice.tone === "danger" ? <TriangleAlert className="h-4 w-4" /> : undefined}
          >
            {notice.text}
          </Callout>
        ) : null}

        {!nodeId ? (
          <p className="text-sm text-muted-foreground">{t("bridge.pickNode")}</p>
        ) : !routes ? (
          <p className="text-sm text-muted-foreground">
            {loading ? t("bridge.loading") : t("bridge.loadFailed")}
          </p>
        ) : (
          <>
            <CurrentAssignment
              routes={routes}
              busy={busy}
              loading={loading}
              onDirect={() => void activate(null)}
              onRefresh={() => nodeId && void load(nodeId)}
            />

            {routes.drafts.map((route) => (
              <CandidateRoute
                key={route.id}
                route={route}
                bridge={bridges.find((bridge) => bridge.id === route.bridgeId) ?? null}
                testKeys={testKeys}
                busy={busy}
                loading={loading}
                onRefresh={() => void load(nodeId)}
                request={request}
                onRun={run}
                onActivate={(marker) => void activate(route.id, marker)}
              />
            ))}

            {eligibility ? <EligibilityView eligibility={eligibility} /> : null}

            <PrepareForm
              bridges={bridges}
              busy={busy === "prepare"}
              onPrepare={(bridgeId, port) =>
                void run("prepare", async () => {
                  const result = await prepareRoute(request, nodeId, bridgeId, port);
                  return result.created ? t("bridge.prepared") : t("bridge.preparedExisting");
                })
              }
            />

            {routes.retiring.map((route) => (
              <CandidateRoute
                key={route.id}
                route={route}
                bridge={bridges.find((bridge) => bridge.id === route.bridgeId) ?? null}
                testKeys={testKeys}
                busy={busy}
                loading={loading}
                onRefresh={() => void load(nodeId)}
                request={request}
                onRun={run}
                onActivate={(marker) => void activate(route.id, marker)}
              />
            ))}
          </>
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
    <section className="space-y-2 rounded-lg border p-3">
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
    <details className="rounded-lg border px-3 py-2" open={eligibility.unsupported > 0}>
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
      className="space-y-2 rounded-lg border p-3"
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
    <section className="space-y-3 rounded-lg border p-3">
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

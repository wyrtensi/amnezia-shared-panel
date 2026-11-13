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
} from "@/lib/bridge-ui";
import { useT } from "@/lib/i18n/provider";
import type { KeyView } from "@/lib/types";

type Notice = { tone: "danger" | "success" | "warning"; text: string };

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

  /** Run one API action; show its error and reload when the data went stale. */
  const run = async (name: string, action: () => Promise<string | void>) => {
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
      if (described.refetch) await load(nodeId);
    } finally {
      setBusy(null);
    }
  };

  const revision = routes?.vpnEndpointRevision ?? 0;

  const activate = (routeId: string | null) =>
    run(routeId ?? "direct", async () => {
      const result = await setNodeEndpoint(request, nodeId!, routeId, revision);
      await reloadAdmin();
      return result.vpnEndpoint.changed
        ? routeId
          ? t("bridge.activated")
          : t("bridge.switchedDirect")
        : t("bridge.unchanged");
    });

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
          <select
            id="route-node"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm sm:max-w-sm"
            value={nodeId ?? ""}
            onChange={(event) => setNodeId(event.target.value || null)}
          >
            <option value="">{t("bridge.selectNodePlaceholder")}</option>
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
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

            {routes.drafts.map((route) => (
              <CandidateRoute
                key={route.id}
                route={route}
                bridge={bridges.find((bridge) => bridge.id === route.bridgeId) ?? null}
                testKeys={testKeys}
                busy={busy}
                request={request}
                onRun={run}
                onActivate={() => void activate(route.id)}
              />
            ))}
            {routes.retiring.map((route) => (
              <CandidateRoute
                key={route.id}
                route={route}
                bridge={bridges.find((bridge) => bridge.id === route.bridgeId) ?? null}
                testKeys={testKeys}
                busy={busy}
                request={request}
                onRun={run}
                onActivate={() => void activate(route.id)}
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
    <section className="space-y-1.5 rounded-lg border p-3">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold">
        {t("bridge.eligibility")}
        <Hint>{t("bridge.eligibilityHint")}</Hint>
      </h4>
      <ul className="grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
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
    </section>
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
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="route-bridge">{t("bridge.chooseBridge")}</Label>
            <select
              id="route-bridge"
              required
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              value={bridgeId}
              onChange={(event) => setBridgeId(event.target.value)}
            >
              <option value="">{t("bridge.chooseBridgePlaceholder")}</option>
              {bridges.map((bridge) => (
                <option key={bridge.id} value={bridge.id}>
                  {bridge.name} · {bridge.publicIpv4} ·{" "}
                  {t("bridge.freePorts", {
                    free: Math.max(0, bridge.capacity - bridge.heldPorts),
                  })}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="route-port">{t("bridge.portOverride")}</Label>
            <Input
              id="route-port"
              type="number"
              min={1}
              max={65535}
              placeholder={t("bridge.portAuto")}
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy || !bridgeId}>
            {t("bridge.prepare")}
          </Button>
        </div>
      )}
    </form>
  );
}

function CandidateRoute({
  route,
  bridge,
  testKeys,
  busy,
  request,
  onRun,
  onActivate,
}: {
  route: NodeBridgeRoute;
  bridge: Bridge | null;
  testKeys: KeyView[];
  busy: string | null;
  request: Requester;
  onRun: (name: string, action: () => Promise<string | void>) => Promise<void>;
  onActivate: () => void;
}) {
  const { t, lang } = useT();
  const [marker, setMarker] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  const [keyId, setKeyId] = React.useState("");
  const [releasing, setReleasing] = React.useState(false);
  const disabled = busy !== null;
  const retiring = route.state === "retiring";

  // Offer the marker the bridge reported, so attesting what was observed takes
  // no retyping; a marker taken from the test config overrides it below.
  React.useEffect(() => {
    if (!marker && route.observedRegistrationMarker) {
      setMarker(route.observedRegistrationMarker);
    }
  }, [route.observedRegistrationMarker, marker]);
  React.useEffect(() => {
    if (!keyId && testKeys[0]) setKeyId(testKeys[0].id);
  }, [testKeys, keyId]);

  const downloadTest = () =>
    onRun(`test-${route.id}`, async () => {
      const config = await fetchTestConfig(route.id, keyId);
      const url = URL.createObjectURL(config.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = config.filename;
      link.click();
      URL.revokeObjectURL(url);
      if (config.marker) setMarker(config.marker);
      return config.marker ? t("bridge.testDownloaded") : t("bridge.testDownloadedNoMarker");
    });

  return (
    <section className="space-y-3 rounded-lg border p-3">
      <h4 className="text-sm font-semibold">
        {retiring ? t("bridge.retiringRoute") : t("bridge.candidateRoute")}
      </h4>
      <BridgeRouteFacts route={route} t={t} lang={lang} />

      {route.setupCommands ? (
        <div className="space-y-2">
          <p className="text-xs font-medium">{t("bridge.nodeSetup")}</p>
          <CommandBlock
            label={t("bridge.dryRunCommand")}
            command={route.setupCommands.dryRun}
          />
          <CommandBlock
            label={t("bridge.installCommand")}
            command={route.setupCommands.install}
          />
        </div>
      ) : null}

      {bridge && bridgeNeedsHostSetup(bridge) && bridge.setupCommands ? (
        <div className="space-y-2">
          <p className="text-xs font-medium">{t("bridge.hostSetupFirst")}</p>
          <CommandBlock
            label={t("bridge.dryRunCommand")}
            command={bridge.setupCommands.dryRun}
          />
          <CommandBlock
            label={t("bridge.installCommand")}
            command={bridge.setupCommands.install}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("bridge.hostSetupDone")}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            void onRun(`probe-${route.id}`, async () => {
              const result = await verifyRouteByProbe(request, route.id);
              if (result.method !== "probe") return;
              return t(`bridge.probe.${result.status}`);
            })
          }
        >
          {t("bridge.verifyProbe")}
        </Button>
      </div>

      <div className="space-y-2 rounded-md bg-muted/40 p-2">
        <p className="text-xs font-medium">{t("bridge.testConfig")}</p>
        {testKeys.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("bridge.testConfigNoKey")}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t("bridge.testKey")}
              className="flex h-9 min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              value={keyId}
              onChange={(event) => setKeyId(event.target.value)}
            >
              {testKeys.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.deviceLabel || key.deviceType} · {key.id.slice(0, 8)}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || !keyId}
              onClick={() => void downloadTest()}
            >
              <Download className="h-4 w-4" /> {t("bridge.testDownload")}
            </Button>
          </div>
        )}
      </div>

      <form
        className="space-y-2 rounded-md bg-muted/40 p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void onRun(`operator-${route.id}`, async () => {
            await verifyRouteByOperator(request, route.id, marker.trim());
            setConfirmed(false);
            return t("bridge.operatorRecorded");
          });
        }}
      >
        <p className="text-xs font-medium">{t("bridge.operatorVerify")}</p>
        <div className="space-y-1.5">
          <Label htmlFor={`marker-${route.id}`}>{t("bridge.marker")}</Label>
          <Input
            id={`marker-${route.id}`}
            className="font-mono"
            autoComplete="off"
            value={marker}
            onChange={(event) => setMarker(event.target.value)}
          />
        </div>
        <label className="flex items-start gap-2 text-xs">
          <Checkbox
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>{t("bridge.operatorConfirm")}</span>
        </label>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={disabled || !confirmed || marker.trim() === ""}
        >
          {t("bridge.operatorSubmit")}
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={disabled} onClick={onActivate}>
          {t("bridge.activate")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => setReleasing(true)}
        >
          {retiring ? t("bridge.releaseRetiring") : t("bridge.cancelDraft")}
        </Button>
      </div>

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

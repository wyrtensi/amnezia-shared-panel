"use client";

import * as React from "react";
import { Play, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  PROBE_LEVELS,
  type AdminReachabilityBridge,
  type ProbeLevel,
  type ProbeLevelName,
  type ReachabilityStatus,
  type UpsertReachabilityProbeRequest,
} from "@amnezia/contracts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/hint";
import { Switch } from "@/components/ui/switch";
import { apiRequest } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { Lang } from "@/lib/i18n/messages";
import { useT } from "@/lib/i18n/provider";
import type { AdminReachabilityNode, AdminReachabilityView } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { ReachabilityState } from "@/components/admin/use-reachability";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

type BadgeVariant = "success" | "destructive" | "outline";

/**
 * The badge for a node's or a protocol's verdict.
 *
 * `error` means the probe could not tell — its control failed, a target could
 * not be set up, or it never reported. Shown as "unavailable" it would page an
 * operator about a node that may be perfectly fine, so it gets its own word
 * and the same neutral look as "no data".
 */
export const reachabilityStatusBadge = (
  status: ReachabilityStatus | null,
): { variant: BadgeVariant; labelKey: string } => {
  switch (status) {
    case "ok":
      return { variant: "success", labelKey: "reachability.status.ok" };
    case "failed":
      return { variant: "destructive", labelKey: "reachability.status.failed" };
    case "error":
      return { variant: "outline", labelKey: "reachability.status.error" };
    default:
      return { variant: "outline", labelKey: "reachability.status.none" };
  }
};

/** One level as passed, failed, or not attempted (`ok: null`, or absent). */
export const levelMark = (
  level: ProbeLevel | null | undefined,
): "ok" | "fail" | "none" => {
  if (!level || level.ok === null) return "none";
  return level.ok ? "ok" : "fail";
};

/** Level names as an operator reads them; the tcp level knocks on port 22. */
const LEVEL_LABEL: Record<Exclude<ProbeLevelName, "download"> | "https", string> = {
  ping: "ping",
  tcp: "tcp/22",
  handshake: "handshake",
  http: "http",
  https: "https",
};

const MARK_CLASS: Record<ReturnType<typeof levelMark>, string> = {
  ok: "text-success",
  fail: "text-destructive",
  none: "text-muted-foreground",
};

function StatusBadge({
  status,
  t,
}: {
  status: ReachabilityStatus | null;
  t: Translate;
}) {
  const badge = reachabilityStatusBadge(status);
  return <Badge variant={badge.variant}>{t(badge.labelKey)}</Badge>;
}

function LevelLine({ name, level, t }: {
  name: ProbeLevelName | "https";
  level: ProbeLevel | undefined;
  t: Translate;
}) {
  const mark = levelMark(level);
  return (
    <li data-level={name} data-mark={mark} title={level?.detail ?? undefined}>
      <span className="text-muted-foreground">
        {name === "download" ? t("reachability.download") : LEVEL_LABEL[name]}
      </span>{" "}
      <span className={MARK_CLASS[mark]}>{t(`reachability.level.${mark}`)}</span>
      {mark === "ok" && level?.latencyMs != null ? (
        <span className="text-muted-foreground"> {level.latencyMs}ms</span>
      ) : null}
    </li>
  );
}

function ProtocolLine({
  result,
  t,
  lang,
}: {
  result: AdminReachabilityNode["protocols"][number];
  t: Translate;
  lang: Lang;
}) {
  return (
    <li className="space-y-1 rounded-md bg-well px-2 py-1.5 text-xs shadow-[var(--inset-shadow)]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{t(`protocol.${result.protocol}`)}</span>
        <StatusBadge status={result.status} t={t} />
        {result.checkedAt ? (
          <span className="text-muted-foreground">
            {formatDateTime(result.checkedAt, lang)}
          </span>
        ) : null}
        {result.keyState && result.keyState !== "active" ? (
          <span className="text-muted-foreground">
            {t("reachability.keyState", { state: result.keyState })}
          </span>
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {PROBE_LEVELS.map((name) => {
          const level = result.levels?.[name];
          if (name === "download" && !level) return null;
          return <LevelLine key={name} name={name} level={level} t={t} />;
        })}
      </ul>
      {result.levels?.download?.ok === false && result.levels.download.detail ? (
        <p className="break-words text-muted-foreground">{result.levels.download.detail}</p>
      ) : null}
      {result.egressIp || result.detail ? (
        <div className="flex flex-wrap gap-x-3 text-muted-foreground">
          {result.egressIp ? (
            <span className="font-mono">
              {t("reachability.egress", { ip: result.egressIp })}
            </span>
          ) : null}
          {result.detail ? (
            <span className="min-w-0 break-words">{result.detail}</span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function NodeRow({
  node,
  t,
  lang,
  busy,
  onToggle,
}: {
  node: AdminReachabilityNode;
  t: Translate;
  lang: Lang;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  // Excluded from the probe: still listed so the switch stays reachable (and
  // at full strength), but the rest is dimmed so an old verdict does not read
  // as a current one.
  const dim = !node.reachabilityEnabled && "opacity-60";
  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className={cn("min-w-0 space-y-0.5", dim)}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{node.nodeName}</span>
            <StatusBadge status={node.status} t={t} />
            {node.incidentOpen ? (
              <Badge variant="destructive">
                <TriangleAlert className="h-3 w-3" /> {t("reachability.incident")}
              </Badge>
            ) : null}
            {!node.nodeEnabled ? (
              <Badge variant="outline">{t("reachability.nodeDisabled")}</Badge>
            ) : null}
            {!node.reachabilityEnabled ? (
              <Badge variant="outline">{t("reachability.excluded")}</Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {node.checkedAt ? (
              <span>
                {t("reachability.checkedAt", {
                  time: formatDateTime(node.checkedAt, lang),
                })}
              </span>
            ) : null}
            {node.failingSince ? (
              <span className="text-destructive">
                {t("reachability.failingSince", {
                  time: formatDateTime(node.failingSince, lang),
                })}
              </span>
            ) : null}
          </div>
          {node.detail ? (
            <p className="break-words text-xs text-muted-foreground">
              {node.detail}
            </p>
          ) : null}
          {node.directStatus ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("reachability.direct")}</span>
              <StatusBadge status={node.directStatus} t={t} />
              {node.directCheckedAt ? <span>{formatDateTime(node.directCheckedAt, lang)}</span> : null}
              {node.directDetail ? <span className="break-words">{node.directDetail}</span> : null}
            </div>
          ) : null}
        </div>
        <Switch
          checked={node.reachabilityEnabled}
          disabled={busy}
          aria-label={t("reachability.switchAria", { name: node.nodeName })}
          onCheckedChange={onToggle}
        />
      </div>
      {node.publicEndpoints?.length ? (
        <ul className="space-y-1">
          {node.publicEndpoints.map((endpoint) => (
            <li key={endpoint.id} className="flex flex-wrap items-center justify-between gap-1 rounded-md bg-well px-2 py-1 text-xs">
              <span>{endpoint.name} <code className="text-muted-foreground">{endpoint.publicAddress}</code></span>
              {endpoint.enabled ? <StatusBadge status={endpoint.probeStatus} t={t} />
                : <Badge variant="outline">{t("reachability.excluded")}</Badge>}
            </li>
          ))}
        </ul>
      ) : null}
      {node.protocols.length === 0 ? (
        <p className={cn("text-xs text-muted-foreground", dim)}>
          {t("reachability.noProtocols")}
        </p>
      ) : (
        <ul className={cn("space-y-1.5", dim)}>
          {node.protocols.map((result) => (
            <ProtocolLine
              key={result.protocol}
              result={result}
              t={t}
              lang={lang}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const BRIDGE_HOST_LEVELS = ["ping", "tcp", "https"] as const;
const PROBE_MODES = [
  ["probeDirectWhenBridged", "reachability.directMode"],
  ["stealthMode", "reachability.stealthMode"],
] as const;
type ProbeMode = (typeof PROBE_MODES)[number][0];

function BridgeRow({ bridge, t, lang, busy, onToggle }: {
  bridge: AdminReachabilityBridge;
  t: Translate;
  lang: Lang;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { probeLevels } = bridge;
  const frpsStatus = bridge.frpsReachable === null ? null : bridge.frpsReachable ? "ok" : "failed";
  return (
    <div className="space-y-2 border-t pt-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{bridge.bridgeName}</span>
          <span className="font-mono text-muted-foreground">{bridge.publicIpv4}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{t("reachability.bridgeAlerts")}</span>
          <Switch
            checked={bridge.reachabilityEnabled}
            disabled={busy}
            aria-label={t("reachability.bridgeSwitchAria", { name: bridge.bridgeName })}
            onCheckedChange={onToggle}
          />
        </div>
      </div>
      <div className="space-y-1 text-muted-foreground">
        <div className="flex flex-wrap items-center gap-1.5">
          <span>{t("reachability.externalProbe")}</span>
          <StatusBadge status={bridge.probeStatus} t={t} />
          {bridge.probeIncidentOpen ? <Badge variant="destructive">{t("reachability.incident")}</Badge> : null}
          {bridge.probeCheckedAt ? <span>{formatDateTime(bridge.probeCheckedAt, lang)}</span> : null}
        </div>
        {bridge.probeDetail ? <p className="break-words">{bridge.probeDetail}</p> : null}
        {probeLevels ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px]">
            {BRIDGE_HOST_LEVELS.map((name) => probeLevels[name] ? (
              <LevelLine key={name} name={name} level={probeLevels[name]} t={t} />
            ) : null)}
          </ul>
        ) : null}
      </div>
      <div className="space-y-1 text-muted-foreground">
        <div className="flex flex-wrap items-center gap-1.5">
          <span>{t("reachability.bridgeAgent")}</span>
          <Badge variant="outline">{t(`bridge.status.${bridge.managementStatus}`)}</Badge>
          <span>frps</span>
          <StatusBadge status={frpsStatus} t={t} />
          {bridge.mgmtIncidentOpen ? <Badge variant="destructive">{t("reachability.incident")}</Badge> : null}
        </div>
        {bridge.mgmtDetail ? <p className="break-words">{bridge.mgmtDetail}</p> : null}
      </div>
      {bridge.activeRoutes.length > 0 ? (
        <div className="space-y-1">
          <p className="text-muted-foreground">{t("reachability.routeObservation")}</p>
          <ul className="space-y-1 text-muted-foreground">
            {bridge.activeRoutes.map((route) => (
              <li key={route.routeId} className="flex flex-wrap items-center gap-1.5">
                <span>{route.nodeName}:{route.publicUdpPort}</span>
                <StatusBadge status={route.observedOnline === null ? null : route.observedOnline ? "ok" : "failed"} t={t} />
                {route.incidentOpen ? <Badge variant="destructive">{t("reachability.incident")}</Badge> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The card's content, with no hooks of its own.
 *
 * Split from the card so it renders with `renderToStaticMarkup` in a node test
 * environment: every value and callback it needs arrives as a prop.
 */
export function ReachabilityBody({
  view,
  failed,
  t,
  lang,
  busy,
  onRun,
  onToggleNode,
  onToggleBridge,
  onToggleMode,
  bridgeToggleBusy,
}: {
  view: AdminReachabilityView | null;
  failed: boolean;
  t: Translate;
  lang: Lang;
  busy: string | null;
  bridgeToggleBusy?: boolean;
  onRun: () => void;
  onToggleNode: (nodeId: string, enabled: boolean) => void;
  onToggleBridge?: (bridgeId: string, enabled: boolean) => void;
  onToggleMode?: (field: ProbeMode, enabled: boolean) => void;
}) {
  const probe = view?.probe ?? null;
  const bridges = view?.bridges ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle>
          {probe
            ? t("reachability.title", { label: probe.label })
            : t("reachability.titleNone")}
        </CardTitle>
        {probe ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={onRun}
          >
            <Play className="h-4 w-4" /> {t("reachability.run")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("reachability.scope")}</p>
        {failed ? (
          <Callout tone="danger" className="text-xs">
            {t("reachability.loadFailed")}
          </Callout>
        ) : null}
        {!failed && !probe ? (
          <p className="text-sm text-muted-foreground">
            {t("reachability.notConfigured")}
          </p>
        ) : null}
        {probe ? (
          <>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>
                {t("reachability.lastResult", {
                  time: formatDateTime(probe.lastResultAt, lang),
                })}
              </span>
              {probe.stale ? (
                <Badge variant="warning">{t("reachability.stale")}</Badge>
              ) : null}
              {!probe.enabled ? (
                <Badge variant="outline">{t("reachability.probeDisabled")}</Badge>
              ) : null}
              {probe.runInFlight ? (
                <Badge variant="outline">{t("reachability.runInFlight")}</Badge>
              ) : probe.runRequestedAt ? (
                <Badge variant="outline">{t("reachability.runRequested")}</Badge>
              ) : null}
            </div>
            {PROBE_MODES.map(([field, label]) => typeof probe[field] === "boolean" ? (
              <div key={field} className="flex items-center justify-between gap-2 text-xs">
                <span>{t(label)}</span>
                <Switch
                  checked={probe[field]}
                  disabled={busy !== null || !onToggleMode}
                  aria-label={t(label)}
                  onCheckedChange={(enabled) => onToggleMode?.(field, enabled)}
                />
              </div>
            ) : null)}
            {probe.lastError ? (
              <Callout tone="warning" className="break-words text-xs">
                {t("reachability.lastError", {
                  time: formatDateTime(probe.lastErrorAt, lang),
                  error: probe.lastError,
                })}
              </Callout>
            ) : null}
            {view && view.nodes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("reachability.empty")}
              </p>
            ) : null}
            {(view?.nodes ?? []).map((node) => (
              <NodeRow
                key={node.nodeId}
                node={node}
                t={t}
                lang={lang}
                busy={busy !== null}
                onToggle={(enabled) => onToggleNode(node.nodeId, enabled)}
              />
            ))}
          </>
        ) : null}
        {bridges.length > 0 ? (
          <div className="space-y-2 border-t pt-3">
            <h4 className="text-sm font-medium">{t("reachability.bridges")}</h4>
            {bridges.map((bridge) => (
              <BridgeRow
                key={bridge.bridgeId}
                bridge={bridge}
                t={t}
                lang={lang}
                busy={!!bridgeToggleBusy || !onToggleBridge}
                onToggle={(enabled) => onToggleBridge?.(bridge.bridgeId, enabled)}
              />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ReachabilityCard({
  state,
  onSetNodeEnabled,
  bridgeToggleBusy,
  onSetBridgeEnabled,
}: {
  state: ReachabilityState;
  /**
   * PATCHes the node and reloads both the node list and this view, owned by
   * the page so the node cards and this card cannot disagree after a toggle.
   */
  onSetNodeEnabled: (nodeId: string, enabled: boolean) => Promise<void>;
  bridgeToggleBusy: boolean;
  onSetBridgeEnabled: (bridgeId: string, enabled: boolean) => Promise<void>;
}) {
  const { t, lang } = useT();
  const { view, loading, failed, reload } = state;
  const [busy, setBusy] = React.useState<string | null>(null);

  const act = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await run();
    } catch {
      toast.error(t("reachability.actionFailed"));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return null;

  return (
    <ReachabilityBody
      view={view}
      failed={failed}
      t={t}
      lang={lang}
      busy={busy}
      bridgeToggleBusy={bridgeToggleBusy}
      onRun={() => {
        void act("run", async () => {
          await apiRequest("/api/admin/reachability/run", { method: "POST" });
          // Not "ran it": the worker hands the run to the probe on its next
          // tick, and the results land only once the probe has finished.
          toast.success(t("reachability.runQueued"));
          await reload();
        });
      }}
      onToggleBridge={(bridgeId, enabled) => void onSetBridgeEnabled(bridgeId, enabled)}
      onToggleMode={(field, enabled) => {
        if (!view?.probe) return;
        const { label, apiBaseUrl, controlUrl } = view.probe;
        const body: UpsertReachabilityProbeRequest = { label, apiBaseUrl, controlUrl, [field]: enabled };
        void act(field, async () => {
          await apiRequest("/api/admin/reachability/probe", { method: "PUT", body: JSON.stringify(body) });
          await reload();
        });
      }}
      onToggleNode={(nodeId, enabled) => {
        void act(nodeId, () => onSetNodeEnabled(nodeId, enabled));
      }}
    />
  );
}

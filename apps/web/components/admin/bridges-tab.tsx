"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDownUp, Cable, Cpu, Gauge, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  BRIDGE_DEFAULT_CONTROL_TCP_PORT,
  BRIDGE_DEFAULT_UDP_PORT_END,
  BRIDGE_DEFAULT_UDP_PORT_START,
  type Bridge,
  type BridgeFrpsTlsStatus,
} from "@amnezia/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Callout } from "@/components/ui/hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CommandBlock } from "@/components/admin/command-block";
import { NodeCardSection } from "@/components/admin/node-card-section";
import {
  barFraction,
  METRIC_BAR_SCALES,
  MetricGrid,
  MetricMeter,
  metricBar,
  metricBytes,
  type MetricRow,
} from "@/components/admin/node-metrics";
import { BridgeAgentUpdateFacts, UpdateAgentDialog } from "@/components/admin/bridge-agent-update";
import { BridgeDownloadBadge } from "@/components/admin/bridge-route-view";
import { useAdminData } from "@/components/admin/admin-data";
import type { BridgeInfra } from "@/components/admin/use-bridge-infra";
import { createBridge, deleteBridge, renameBridge } from "@/lib/bridge-api";
import {
  BRIDGES_ANCHOR,
  bridgeCardAnchor,
  describeBridgeError,
  nodeCardAnchor,
  nodeRouteEditorHref,
  poolCapacity,
  registrationTone,
  verificationLabelKey,
  verificationTime,
  verificationTone,
} from "@/lib/bridge-ui";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { Lang } from "@/lib/i18n/messages";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const STATUS_VARIANT = {
  ok: "success",
  pending_enrollment: "outline",
  down: "destructive",
  stale: "warning",
  identity_mismatch: "destructive",
  unsupported: "warning",
} as const;

const ROUTE_STATE_VARIANT = {
  active: "success",
  draft: "outline",
  retiring: "warning",
} as const;

const PANEL_DNS_VARIANT = {
  active: "success",
  https_unreachable: "destructive",
  dns_mismatch: "warning",
  unconfigured: "outline",
} as const;

/**
 * One bridge. Presentational: the container owns requests, so the card can be
 * rendered with any translator and any data.
 */
export function BridgeCardView({
  bridge,
  t,
  lang,
  onRename,
  onDelete,
  onUpdateAgent,
  onToggleReachability,
  reachabilityBusy,
}: {
  bridge: Bridge;
  t: Translate;
  lang: Lang;
  onRename: () => void;
  onDelete: () => void;
  onUpdateAgent?: () => void;
  onToggleReachability?: (enabled: boolean) => void;
  reachabilityBusy?: boolean;
}) {
  const free = Math.max(0, bridge.capacity - bridge.heldPorts);
  return (
    <Card id={bridgeCardAnchor(bridge.id)} tabIndex={-1} className="scroll-mt-4">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg",
              bridge.managementStatus === "ok" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
            )}>
              <Cable aria-hidden className="size-5" />
            </span>
            <div className="min-w-0 space-y-1">
              <p className="break-words font-medium leading-tight">{bridge.name}</p>
              <Badge variant={STATUS_VARIANT[bridge.managementStatus]}>
                {t(`bridge.status.${bridge.managementStatus}`)}
              </Badge>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("bridge.rename")}
              onClick={onRename}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("bridge.delete")}
              onClick={onDelete}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
            {bridge.lastObservedAt
              ? t("bridge.lastObserved", {
                  at: formatDateTime(bridge.lastObservedAt, lang),
                })
              : t("bridge.neverObserved")}
        </p>

        {bridge.reachabilityEnabled !== undefined ? (
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <span>{t("reachability.bridgeAlerts")}</span>
              {bridge.alertState?.incidentOpen ? <Badge variant="destructive">{t("reachability.incident")}</Badge> : null}
            </div>
            <Switch
              checked={bridge.reachabilityEnabled}
              disabled={reachabilityBusy || !onToggleReachability}
              aria-label={t("reachability.bridgeSwitchAria", { name: bridge.name })}
              onCheckedChange={onToggleReachability}
            />
          </div>
        ) : null}
        <BridgeManagementView bridge={bridge} t={t} lang={lang} />
        <BridgeAgentUpdateFacts bridge={bridge} t={t} lang={lang} onUpdate={onUpdateAgent} />

        <dl className="space-y-1.5 text-xs text-muted-foreground">
          <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/60 bg-well px-2 py-1 shadow-[var(--inset-shadow)]">
            <dt>{t("bridge.controlPort")}</dt>
            <dd className="truncate text-right font-mono text-foreground">{bridge.controlTcpPort}/tcp</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/60 bg-well px-2 py-1 shadow-[var(--inset-shadow)]">
            <dt>{t("bridge.udpRange")}</dt>
            <dd className="truncate text-right font-mono text-foreground">
              {bridge.udpPortStart}–{bridge.udpPortEnd}/udp
            </dd>
          </div>
        </dl>
        <div className="space-y-1.5">
          <NodeCardSection
            icon={Gauge}
            action={
              <span className="tabular text-xs font-medium">
                {t("bridge.portsUsed", { used: bridge.heldPorts, total: bridge.capacity, free })}
              </span>
            }
          >
            {t("bridge.ports")}
          </NodeCardSection>
          <MetricMeter meter={metricBar(barFraction(bridge.heldPorts, bridge.capacity))} />
        </div>
        <BridgeMetricsView bridge={bridge} t={t} lang={lang} />

        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            {t("bridge.routes")}
          </p>
          {bridge.routes.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("bridge.noRoutes")}</p>
          ) : (
            <ul className="space-y-1">
              {bridge.routes.map((route) => (
                <li
                  key={route.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted/50 px-2 py-1 text-xs"
                >
                  <a
                    href={`#${nodeCardAnchor(route.nodeId)}`}
                    className="min-w-0 break-words font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {route.nodeName}
                  </a>
                  <span className="font-mono">:{route.publicUdpPort}</span>
                  <Badge variant={ROUTE_STATE_VARIANT[route.state]}>
                    {t(`bridge.state.${route.state}`)}
                  </Badge>
                  {/* Registration (frps) and the end-to-end AWG path are
                      separate evidence from management reachability above. */}
                  <Badge
                    variant={registrationTone(route.registration.status)}
                    title={t("bridge.route.frpc")}
                  >
                    {t("bridge.route.frpc")}: {t(`bridge.obs.${route.registration.status}`)}
                  </Badge>
                  <Badge variant={verificationTone(route.verification)}>
                    {t("bridge.route.awg")}: {t(verificationLabelKey(route.verification))}
                  </Badge>
                  <BridgeDownloadBadge verification={route.verification} t={t} />
                  <EvidenceTime at={verificationTime(route.verification)} lang={lang} />
                  <Link
                    href={nodeRouteEditorHref(route.nodeId)}
                    prefetch={false}
                    className="ml-auto text-primary underline-offset-2 hover:underline"
                  >
                    {t("bridge.routePolicy")}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <BridgePanelDnsDetails bridge={bridge} t={t} />

        {bridge.setupCommands ? (
          <details className="rounded-md border px-2 py-1.5">
            <summary className="cursor-pointer text-xs font-medium">
              {t("bridge.hostSetup")}
            </summary>
            <div className="mt-2 space-y-2">
              <p className="text-xs text-muted-foreground">
                {bridge.setupCommands.agentImage
                  ? t("bridge.hostSetupHintImage", { image: bridge.setupCommands.agentImage })
                  : t("bridge.hostSetupHint")}
              </p>
              <CommandBlock
                label={t("bridge.dryRunCommand")}
                command={bridge.setupCommands.dryRun}
              />
              <CommandBlock
                label={t("bridge.installCommand")}
                command={bridge.setupCommands.install}
              />
            </div>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BridgePanelDnsDetails({ bridge, t }: { bridge: Bridge; t: Translate }) {
  const panelDns = bridge.panelDns;
  const state = panelDns?.state ?? "unconfigured";
  const hostname = panelDns?.hostname ?? bridge.panelDnsHostname ?? null;
  return (
    <details
      className="rounded-md border px-2 py-1.5"
      open={state === "https_unreachable" || state === "dns_mismatch"}
    >
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-xs font-medium">
        <span>{t("bridge.panelDnsIpv4")}</span>
        <span className="flex items-center gap-1.5">
          {hostname ? (
            <span className="font-mono text-muted-foreground">{hostname}</span>
          ) : null}
          <Badge variant={PANEL_DNS_VARIANT[state]}>
            {t(`bridge.panelDns.state.${state}`)}
          </Badge>
        </span>
      </summary>
      <div className="mt-2 space-y-1.5">
        {hostname && state === "active" ? (
          <p className="text-xs text-success">
            {t("bridge.panelDns.activeHint", { hostname })}
          </p>
        ) : null}
        {hostname && state === "https_unreachable" ? (
          <Callout tone="danger" className="text-xs">
            {t("bridge.panelDns.unreachableHint", { hostname })}
          </Callout>
        ) : null}
        {hostname && state === "dns_mismatch" ? (
          <Callout tone="warning" className="text-xs">
            {t("bridge.panelDns.mismatchHint", { hostname })}
          </Callout>
        ) : null}
        <CommandBlock label={t("bridge.panelDnsIpv4")} command={bridge.publicIpv4} hideLabel />
        <p className="text-xs text-muted-foreground">{t("bridge.panelDnsIpv4Hint")}</p>
      </div>
    </details>
  );
}

/**
 * The bridge-agent's side of the card: version, frps and the last poll.
 * Presentational and free of secrets: the enrollment credential is never part
 * of the bridge payload.
 */
function BridgeMetricsView({ bridge, t, lang }: { bridge: Bridge; t: Translate; lang: Lang }) {
  const metrics = bridge.managementStatus === "ok" ? bridge.metrics : undefined;
  const host = metrics?.host;
  const traffic = metrics?.trafficToday;
  const latency = metrics?.agentLatencyMs;
  const rows: MetricRow[] = [];
  if (host) {
    const memUsed = Math.max(0, host.memoryTotalBytes - host.memoryFreeBytes);
    rows.push(
      [
        t("nodes.metrics.cpu"),
        host.cpuUsedPercent === null ? "—" : `${host.cpuUsedPercent}%`,
        undefined,
        metricBar(barFraction(host.cpuUsedPercent, 100)),
      ],
      [
        t("bridge.metrics.freeMemory"),
        `${metricBytes(host.memoryFreeBytes, lang)} / ${metricBytes(host.memoryTotalBytes, lang)}`,
        undefined,
        metricBar(barFraction(memUsed, host.memoryTotalBytes)),
      ],
      [
        t("nodes.metrics.disk"),
        host.diskUsedPercent == null
          ? "—"
          : `${host.diskUsedPercent}% (${metricBytes(host.diskAvailableBytes, lang)} ${t("nodes.metrics.free")})`,
        undefined,
        metricBar(barFraction(host.diskUsedPercent, 100)),
      ],
    );
  }
  if (latency !== undefined) {
    rows.push([
      t("nodes.metrics.agentLatency"),
      `${latency} ms`,
      undefined,
      metricBar(barFraction(latency, METRIC_BAR_SCALES.agentLatencyMs)),
    ]);
  }
  return (
    <div className="space-y-2 border-t pt-2">
      {metrics?.frpsTls ? <BridgeTlsView status={metrics.frpsTls} t={t} lang={lang} /> : null}
      <NodeCardSection icon={Cpu}>{t("nodes.metrics.title")}</NodeCardSection>
      {rows.length > 0 ? <MetricGrid rows={rows} /> : null}
      {!host ? <p className="text-xs text-muted-foreground">{t("bridge.metrics.unavailable")}</p> : null}
      {traffic ? (
        <>
          <NodeCardSection icon={ArrowDownUp}>{t("bridge.metrics.trafficToday")}</NodeCardSection>
          <MetricGrid rows={[
            [t("bridge.metrics.trafficIn"), metricBytes(traffic.inBytes, lang), undefined, null],
            [t("bridge.metrics.trafficOut"), metricBytes(traffic.outBytes, lang), undefined, null],
          ]} />
        </>
      ) : null}
    </div>
  );
}

function BridgeTlsView({ status, t, lang }: {
  status: BridgeFrpsTlsStatus;
  t: Translate;
  lang: Lang;
}) {
  if (status.state === "unconfigured") {
    return <p className="text-xs text-muted-foreground">{t("bridge.tls.unconfigured")}</p>;
  }
  if (status.state === "failed") {
    return <Callout tone="danger" className="text-xs">{t(`bridge.tls.${status.reason}`)}</Callout>;
  }
  return (
    <div className="space-y-1 text-xs">
      <p>{t("bridge.tls.expiresAt", { date: formatDateTime(status.expiresAt, lang) })}</p>
      {status.expiresSoon || status.matchesDeployed === false ? (
        <Callout tone="warning" className="text-xs">
          {status.expiresSoon ? <p>{t("bridge.tls.expiresSoon")}</p> : null}
          {status.matchesDeployed === false ? <p>{t("bridge.tls.mismatch")}</p> : null}
        </Callout>
      ) : null}
    </div>
  );
}

export function BridgeManagementView({
  bridge,
  t,
  lang,
}: {
  bridge: Bridge;
  t: Translate;
  lang: Lang;
}) {
  const management = bridge.management;
  if (!management || !management.enrolled) {
    return <p className="text-xs text-muted-foreground">{t("bridge.mgmt.notEnrolled")}</p>;
  }
  const when = (iso: string | null) =>
    iso ? formatDateTime(iso, lang) : t("bridge.mgmt.never");
  const frps =
    management.frpsReachable === null
      ? t("bridge.mgmt.frpsUnknown")
      : management.frpsReachable
        ? t("bridge.mgmt.frpsReachable", { version: management.frpsVersion ?? "frps" })
        : t("bridge.mgmt.frpsUnreachable");
  return (
    <dl className="space-y-1.5 text-xs text-muted-foreground">
      <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/60 bg-well px-2 py-1 shadow-[var(--inset-shadow)]">
        <dt>{t("bridge.mgmt.agent")}</dt>
        <dd className="truncate text-right font-mono text-foreground">{management.agentVersion ?? t("bridge.unknown")}</dd>
      </div>
      <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/60 bg-well px-2 py-1 shadow-[var(--inset-shadow)]">
        <dt>{t("bridge.mgmt.frps")}</dt>
        <dd className="truncate text-right text-foreground">{frps}</dd>
      </div>
      <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/60 bg-well px-2 py-1 shadow-[var(--inset-shadow)]">
        <dt>{t("bridge.mgmt.lastOk")}</dt>
        <dd className="truncate text-right text-foreground">{when(bridge.lastObservedAt)}</dd>
      </div>
      <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/60 bg-well px-2 py-1 shadow-[var(--inset-shadow)]">
        <dt>{t("bridge.mgmt.lastPoll")}</dt>
        <dd className="truncate text-right text-foreground">{when(management.lastPollAttemptAt)}</dd>
      </div>
      {management.lastErrorCode ? (
        <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/60 bg-well px-2 py-1 shadow-[var(--inset-shadow)]">
          <dt>{t("bridge.mgmt.problem")}</dt>
          <dd className="break-all text-right font-mono text-destructive">{management.lastErrorCode}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function EvidenceTime({ at, lang }: { at: string | null; lang: Lang }) {
  return at ? (
    <span className="text-muted-foreground">{formatDateTime(at, lang)}</span>
  ) : null;
}

export function BridgesSection({ infra, reachabilityBusy, onSetReachability }: {
  infra: BridgeInfra;
  reachabilityBusy: boolean;
  onSetReachability: (bridgeId: string, enabled: boolean) => Promise<void>;
}) {
  const { t, lang } = useT();
  const { request } = useAdminData();
  const [showAdd, setShowAdd] = React.useState(false);
  const [renaming, setRenaming] = React.useState<Bridge | null>(null);
  const [deleting, setDeleting] = React.useState<Bridge | null>(null);
  const [updating, setUpdating] = React.useState<Bridge | null>(null);

  return (
    <section id={BRIDGES_ANCHOR} aria-labelledby="bridges-title" tabIndex={-1} className="min-w-0 scroll-mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="bridges-title" className="mr-auto text-base font-semibold">{t("bridge.title")}</h3>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus /> {t("bridge.add")}
        </Button>
      </div>

      {infra.failed ? (
        <Callout tone="danger">{t("bridge.loadFailed")}</Callout>
      ) : null}

      {infra.loading && infra.bridges.length === 0 ? (
        <Skeleton className="h-56 rounded-xl" />
      ) : infra.bridges.length === 0 ? (
        !infra.failed && <Card className="border-dashed">
          <CardContent className="space-y-1 p-4 text-sm">
            <p className="font-medium">{t("bridge.empty")}</p>
            <p className="text-muted-foreground">{t("bridge.emptyHint")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {infra.bridges.map((bridge) => (
            <BridgeCardView
              key={bridge.id}
              bridge={bridge}
              t={t}
              lang={lang}
              onRename={() => setRenaming(bridge)}
              onDelete={() => setDeleting(bridge)}
              onUpdateAgent={() => setUpdating(bridge)}
              reachabilityBusy={reachabilityBusy}
              onToggleReachability={(enabled) => void onSetReachability(bridge.id, enabled)}
            />
          ))}
        </div>
      )}

      <AddBridgeDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onDone={infra.reload}
        request={request}
      />
      <RenameBridgeDialog
        bridge={renaming}
        onClose={() => setRenaming(null)}
        onDone={infra.reload}
        request={request}
      />
      <UpdateAgentDialog
        bridge={updating}
        onClose={() => setUpdating(null)}
        onDone={infra.reload}
        request={request}
      />
      <DeleteBridgeDialog
        bridge={deleting}
        onClose={() => setDeleting(null)}
        onDone={infra.reload}
        request={request}
      />
    </section>
  );
}

type DialogDeps = {
  onClose: () => void;
  onDone: () => Promise<void>;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
};

function AddBridgeDialog({
  open,
  onClose,
  onDone,
  request,
}: DialogDeps & { open: boolean }) {
  const { t } = useT();
  const [name, setName] = React.useState("");
  const [ip, setIp] = React.useState("");
  const [panelDomain, setPanelDomain] = React.useState("");
  const [controlPort, setControlPort] = React.useState(
    String(BRIDGE_DEFAULT_CONTROL_TCP_PORT),
  );
  const [udpStart, setUdpStart] = React.useState(String(BRIDGE_DEFAULT_UDP_PORT_START));
  const [udpEnd, setUdpEnd] = React.useState(String(BRIDGE_DEFAULT_UDP_PORT_END));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setIp("");
    setPanelDomain("");
    setControlPort(String(BRIDGE_DEFAULT_CONTROL_TCP_PORT));
    setUdpStart(String(BRIDGE_DEFAULT_UDP_PORT_START));
    setUdpEnd(String(BRIDGE_DEFAULT_UDP_PORT_END));
    setError(null);
  }, [open]);

  const fits = poolCapacity(Number(udpStart), Number(udpEnd));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmedDomain = panelDomain.trim();
      await createBridge(request, {
        name: name.trim(),
        publicIpv4: ip.trim(),
        controlTcpPort: Number(controlPort),
        udpPortStart: Number(udpStart),
        udpPortEnd: Number(udpEnd),
        ...(trimmedDomain ? { panelDnsHostname: trimmedDomain } : {}),
      });
      toast.success(t("bridge.added"));
      onClose();
      await onDone();
    } catch (cause) {
      setError(describeBridgeError(cause, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("bridge.add")}</DialogTitle>
          <DialogDescription>{t("bridge.addDesc")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="bridge-name">{t("common.name")}</Label>
            <Input
              id="bridge-name"
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bridge-ip">{t("bridge.publicIpv4")}</Label>
            <Input
              id="bridge-ip"
              required
              inputMode="decimal"
              autoComplete="off"
              placeholder="198.51.100.10"
              value={ip}
              onChange={(event) => setIp(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bridge-panel-domain">{t("bridge.panelDnsHostname")}</Label>
            <Input
              id="bridge-panel-domain"
              maxLength={253}
              autoComplete="off"
              placeholder={t("bridge.panelDnsHostnamePlaceholder")}
              value={panelDomain}
              onChange={(event) => setPanelDomain(event.target.value)}
            />
          </div>
          <details className="rounded-md border px-2 py-1.5">
            <summary className="cursor-pointer text-sm font-medium">
              {t("bridge.advanced")}
            </summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="bridge-control">{t("bridge.controlPort")}</Label>
                <Input
                  id="bridge-control"
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={controlPort}
                  onChange={(event) => setControlPort(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bridge-udp-start">{t("bridge.udpStart")}</Label>
                <Input
                  id="bridge-udp-start"
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={udpStart}
                  onChange={(event) => setUdpStart(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bridge-udp-end">{t("bridge.udpEnd")}</Label>
                <Input
                  id="bridge-udp-end"
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={udpEnd}
                  onChange={(event) => setUdpEnd(event.target.value)}
                />
              </div>
            </div>
          </details>
          <p className="text-xs text-muted-foreground">
            {t("bridge.routesFit", { count: fits })}
          </p>
          {error ? (
            <Callout tone="danger" className="text-xs">
              {error}
            </Callout>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t("common.adding") : t("common.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameBridgeDialog({
  bridge,
  onClose,
  onDone,
  request,
}: DialogDeps & { bridge: Bridge | null }) {
  const { t } = useT();
  const [name, setName] = React.useState("");
  const [panelDomain, setPanelDomain] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setName(bridge?.name ?? "");
    setPanelDomain(bridge?.panelDnsHostname ?? bridge?.panelDns?.hostname ?? "");
    setError(null);
  }, [bridge]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      const trimmedDomain = panelDomain.trim();
      await renameBridge(
        request,
        bridge.id,
        name.trim(),
        trimmedDomain ? trimmedDomain : null,
      );
      toast.success(t("bridge.renamed"));
      onClose();
      await onDone();
    } catch (cause) {
      setError(describeBridgeError(cause, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(bridge)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("bridge.rename")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="bridge-edit-name">{t("common.name")}</Label>
            <Input
              id="bridge-edit-name"
              aria-label={t("common.name")}
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bridge-edit-domain">{t("bridge.panelDnsHostname")}</Label>
            <Input
              id="bridge-edit-domain"
              maxLength={253}
              autoComplete="off"
              placeholder={t("bridge.panelDnsHostnamePlaceholder")}
              value={panelDomain}
              onChange={(event) => setPanelDomain(event.target.value)}
            />
          </div>
          {error ? (
            <Callout tone="danger" className="text-xs">
              {error}
            </Callout>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || name.trim() === ""}>
              {busy ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteBridgeDialog({
  bridge,
  onClose,
  onDone,
  request,
}: DialogDeps & { bridge: Bridge | null }) {
  const { t } = useT();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => setError(null), [bridge]);

  const submit = async () => {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      await deleteBridge(request, bridge.id);
      toast.success(t("bridge.deleted"));
      onClose();
      await onDone();
    } catch (cause) {
      // BRIDGE_HAS_ROUTES arrives here as its readable message; the list is
      // reloaded because a stale route list is the usual reason for it.
      const described = describeBridgeError(cause, t);
      setError(described.message);
      if (described.code === "BRIDGE_HAS_ROUTES") await onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(bridge)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("bridge.deleteTitle", { name: bridge?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("bridge.deleteDesc")}</DialogDescription>
        </DialogHeader>
        {error ? (
          <Callout tone="danger" className="text-xs">
            {error}
          </Callout>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => void submit()}
          >
            {t("bridge.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

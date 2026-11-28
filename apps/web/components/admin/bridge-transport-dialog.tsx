"use client";

import * as React from "react";
import { SlidersHorizontal, Zap } from "lucide-react";
import { toast } from "sonner";
import {
  BRIDGE_WYTUNNEL_DEFAULT_KEEPALIVE_SEC,
  BRIDGE_WYTUNNEL_DEFAULT_POOL_SIZE,
  BRIDGE_WYTUNNEL_DEFAULT_ROTATE_DRAIN_SEC,
  BRIDGE_WYTUNNEL_DEFAULT_ROTATE_INTERVAL_SEC,
  normalizeWytunnelTransportConfig,
  type BridgeRouteTelemetry,
  type BridgeRouteTransport,
  type WytunnelHandshakeMode,
  type WytunnelTransportConfig,
} from "@amnezia/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Callout } from "@/components/ui/hint";
import { updateRouteTransport, type Requester } from "@/lib/bridge-api";
import { describeBridgeError } from "@/lib/bridge-ui";
import { useT } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const POOL_PRESETS = [0, 4, 8, 10, 16] as const;
const ROTATE_PRESETS = [
  { labelKey: "bridge.wytunnel.rotateOff", sec: 0 },
  { label: "15m", sec: 900 },
  { label: "30m", sec: 1800 },
  { label: "45m", sec: 2700 },
  { label: "60m", sec: 3600 },
] as const;

export type EditableRouteTransportTarget = {
  id: string;
  publicUdpPort: number;
  transport?: BridgeRouteTransport;
  transportPort?: number | null;
  transportConfig?: WytunnelTransportConfig;
  label?: string;
};

/**
 * Compact transport badge & live WyTunnel telemetry readout for bridge cards
 * and node route rows.
 */
export function BridgeRouteTransportStrip({
  transport,
  transportPort,
  transportConfig,
  telemetry,
  t,
}: {
  transport?: BridgeRouteTransport;
  transportPort?: number | null;
  transportConfig?: WytunnelTransportConfig;
  telemetry?: BridgeRouteTelemetry | null;
  t: Translate;
}) {
  if (transport !== "wytunnel") {
    return (
      <Badge variant="outline" className="text-[11px]">
        {t("bridge.transport.frp_tcp")}
      </Badge>
    );
  }
  const cfg = normalizeWytunnelTransportConfig(transportConfig);
  const poolHealth =
    telemetry?.mode === "pool" && telemetry.targetStreams !== undefined
      ? `${telemetry.healthyStreams ?? 0}/${telemetry.targetStreams}`
      : cfg.poolSize > 0
        ? `×${cfg.poolSize}`
        : "direct";
  const rtt =
    telemetry?.poolRttMs != null ? `${Math.round(telemetry.poolRttMs)} ms` : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant="secondary" className="gap-1 font-mono text-[11px]">
        <Zap className="size-3 text-primary" />
        WyTunnel
        {transportPort ? ` :${transportPort}` : ""}
        {" · "}
        {poolHealth}
        {rtt ? ` · ${rtt}` : ""}
      </Badge>
      {telemetry?.rotationsTotal ? (
        <span
          className="text-[11px] text-muted-foreground tabular"
          title={t("bridge.wytunnel.rotations")}
        >
          rot {telemetry.rotationsTotal}
        </span>
      ) : null}
      {telemetry?.failoversTotal ? (
        <span
          className="text-[11px] text-warning tabular"
          title={t("bridge.wytunnel.failovers")}
        >
          fo {telemetry.failoversTotal}
        </span>
      ) : null}
    </span>
  );
}

const TLS_HEADER_PRESET_BASE64 = "FgMBAAUAAAAAAQ==";

/**
 * Modal editor for switching a bridge route between FRP (TCP) and WyTunnel
 * (FakeTCP multi-tunnel pool with auto-rotation) and tuning all parameters.
 */
export function BridgeTransportDialog({
  route,
  onClose,
  onDone,
  request,
}: {
  route: EditableRouteTransportTarget | null;
  onClose: () => void;
  onDone: () => Promise<void>;
  request: Requester;
}) {
  const { t } = useT();
  const [transport, setTransport] = React.useState<BridgeRouteTransport>("wytunnel");
  const [transportPort, setTransportPort] = React.useState("");
  const [poolSize, setPoolSize] = React.useState(BRIDGE_WYTUNNEL_DEFAULT_POOL_SIZE);
  const [rotateIntervalSec, setRotateIntervalSec] = React.useState(
    BRIDGE_WYTUNNEL_DEFAULT_ROTATE_INTERVAL_SEC,
  );
  const [rotateDrainSec, setRotateDrainSec] = React.useState(
    BRIDGE_WYTUNNEL_DEFAULT_ROTATE_DRAIN_SEC,
  );
  const [keepaliveSec, setKeepaliveSec] = React.useState(
    BRIDGE_WYTUNNEL_DEFAULT_KEEPALIVE_SEC,
  );
  const [fecPreset, setFecPreset] = React.useState<string>("off");
  const [handshakeMode, setHandshakeMode] =
    React.useState<WytunnelHandshakeMode>("none");
  const [handshakeSni, setHandshakeSni] = React.useState("");
  const [handshakePath, setHandshakePath] = React.useState("");
  const [handshakePacketData, setHandshakePacketData] = React.useState("");
  const [ebpfEnabled, setEbpfEnabled] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!route) return;
    const cfg = normalizeWytunnelTransportConfig(route.transportConfig);
    setTransport(route.transport ?? "frp_tcp");
    setTransportPort(route.transportPort ? String(route.transportPort) : "");
    setPoolSize(cfg.poolSize);
    setRotateIntervalSec(cfg.poolRotateIntervalSec);
    setRotateDrainSec(cfg.poolRotateDrainSec);
    setKeepaliveSec(cfg.keepaliveSec);
    setFecPreset(cfg.fec ? `${cfg.fec.k}:${cfg.fec.m}` : "off");
    setHandshakeMode(cfg.handshakeMode);
    setHandshakeSni(cfg.handshakeSni ?? "");
    setHandshakePath(cfg.handshakePath ?? "");
    setHandshakePacketData(cfg.handshakePacketData ?? "");
    setEbpfEnabled(cfg.ebpfEnabled);
    setError(null);
  }, [route]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!route) return;
    if (transport === "wytunnel" && keepaliveSec !== 0 && (keepaliveSec < 5 || keepaliveSec > 300)) {
      setError(t("bridge.wytunnel.keepaliveInvalid"));
      return;
    }
    if (transport === "wytunnel" && handshakeMode === "custom" && handshakePacketData.trim() === "") {
      setError(t("bridge.wytunnel.handshakeCustomRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fec =
        fecPreset === "off"
          ? null
          : (() => {
              const [k, m] = fecPreset.split(":").map(Number);
              return k && m ? { k, m } : null;
            })();
      const parsedPort = transportPort.trim() === "" ? null : Number(transportPort);
      await updateRouteTransport(request, route.id, {
        transport,
        ...(transport === "wytunnel"
          ? {
              transportPort: parsedPort,
              transportConfig: {
                poolSize,
                poolRotateIntervalSec: rotateIntervalSec,
                poolRotateDrainSec: rotateDrainSec,
                keepaliveSec,
                fec,
                handshakeMode,
                handshakeSni:
                  handshakeMode === "tls_client_hello" || handshakeMode === "http_ws_upgrade"
                    ? handshakeSni.trim() || null
                    : null,
                handshakePath:
                  handshakeMode === "http_ws_upgrade" ? handshakePath.trim() || null : null,
                handshakePacketData:
                  handshakeMode === "custom" ? handshakePacketData.trim() || null : null,
                ebpfEnabled,
              },
            }
          : { transportPort: null }),
      });
      toast.success(t("bridge.transport.saved"));
      onClose();
      await onDone();
    } catch (cause) {
      setError(describeBridgeError(cause, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(route)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-primary" />
            {t("bridge.transport.title")}
            {route?.label ? (
              <span className="truncate font-mono text-xs font-normal text-muted-foreground">
                · {route.label}
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription>{t("bridge.transport.desc")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setTransport("wytunnel")}
              className={cn(
                "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                transport === "wytunnel"
                  ? "border-primary bg-primary/[0.06] ring-1 ring-primary/40"
                  : "border-border bg-card hover:bg-accent/40",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Zap className="size-3.5 text-primary" />
                  {t("bridge.transport.wytunnel")}
                </span>
                <Badge variant="success" className="text-[10px]">
                  {t("wizard.recommended")}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("bridge.transport.wytunnelDesc")}
              </p>
            </button>

            <button
              type="button"
              onClick={() => setTransport("frp_tcp")}
              className={cn(
                "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                transport === "frp_tcp"
                  ? "border-primary bg-primary/[0.06] ring-1 ring-primary/40"
                  : "border-border bg-card hover:bg-accent/40",
              )}
            >
              <span className="text-sm font-medium">{t("bridge.transport.frp_tcp")}</span>
              <p className="text-xs text-muted-foreground">
                {t("bridge.transport.frpDesc")}
              </p>
            </button>
          </div>

          {transport === "wytunnel" ? (
            <div className="space-y-4 rounded-lg border bg-well p-3">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor="wt-pool-size">{t("bridge.wytunnel.poolSize")}</Label>
                  <div className="flex flex-wrap gap-1">
                    {POOL_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setPoolSize(preset)}
                        className={cn(
                          "rounded border px-2 py-0.5 font-mono text-xs transition-colors",
                          poolSize === preset
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-card text-muted-foreground hover:bg-accent",
                        )}
                      >
                        {preset === 0 ? t("bridge.wytunnel.directMode") : preset}
                      </button>
                    ))}
                  </div>
                </div>
                <Input
                  id="wt-pool-size"
                  type="number"
                  min={0}
                  max={64}
                  value={poolSize}
                  onChange={(e) => setPoolSize(Math.max(0, Math.min(64, Number(e.target.value) || 0)))}
                />
                <p className="text-xs text-muted-foreground">
                  {t("bridge.wytunnel.poolSizeHint")}
                </p>
              </div>

              {poolSize > 0 ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label>{t("bridge.wytunnel.rotateInterval")}</Label>
                    <div className="flex flex-wrap gap-1">
                      {ROTATE_PRESETS.map((preset) => (
                        <button
                          key={preset.sec}
                          type="button"
                          onClick={() => setRotateIntervalSec(preset.sec)}
                          className={cn(
                            "rounded border px-2 py-0.5 font-mono text-xs transition-colors",
                            rotateIntervalSec === preset.sec
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border bg-card text-muted-foreground hover:bg-accent",
                          )}
                        >
                          {"labelKey" in preset ? t(preset.labelKey) : preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("bridge.wytunnel.rotateIntervalHint")}
                  </p>
                </div>
              ) : null}

              <details className="rounded-md border bg-card px-2.5 py-2">
                <summary className="cursor-pointer text-xs font-medium">
                  {t("bridge.wytunnel.advanced")}
                </summary>
                <div className="mt-3 space-y-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="wt-port" className="text-xs">
                        {t("bridge.wytunnel.transportPort")}
                      </Label>
                      <Input
                        id="wt-port"
                        type="number"
                        min={1}
                        max={65535}
                        placeholder={t("bridge.portAuto")}
                        value={transportPort}
                        onChange={(e) => setTransportPort(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="wt-keepalive" className="text-xs">
                        {t("bridge.wytunnel.keepalive")}
                      </Label>
                      <Input
                        id="wt-keepalive"
                        type="number"
                        min={0}
                        max={300}
                        value={keepaliveSec}
                        onChange={(e) => setKeepaliveSec(Number(e.target.value) || 0)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="wt-drain" className="text-xs">
                        {t("bridge.wytunnel.rotateDrain")}
                      </Label>
                      <Input
                        id="wt-drain"
                        type="number"
                        min={1}
                        max={60}
                        value={rotateDrainSec}
                        onChange={(e) => setRotateDrainSec(Math.max(1, Number(e.target.value) || 5))}
                      />
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-xs">{t("bridge.wytunnel.fec")}</Label>
                      <Select value={fecPreset} onValueChange={setFecPreset}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="off">{t("bridge.wytunnel.fecOff")}</SelectItem>
                          <SelectItem value="20:1">20:1 (+5%)</SelectItem>
                          <SelectItem value="10:1">10:1 (+10%)</SelectItem>
                          <SelectItem value="20:2">20:2 (+10%)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("bridge.wytunnel.handshake")}</Label>
                      <Select
                        value={handshakeMode}
                        onValueChange={(v) => setHandshakeMode(v as WytunnelHandshakeMode)}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">
                            {t("bridge.wytunnel.handshakeNone")}
                          </SelectItem>
                          <SelectItem value="tls_client_hello">
                            {t("bridge.wytunnel.handshakeTls")}
                          </SelectItem>
                          <SelectItem value="http_ws_upgrade">
                            {t("bridge.wytunnel.handshakeWs")}
                          </SelectItem>
                          <SelectItem value="custom">
                            {t("bridge.wytunnel.handshakeCustom")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {handshakeMode === "tls_client_hello" ? (
                    <div className="space-y-1 rounded border bg-well/60 p-2.5">
                      <Label htmlFor="wt-hs-sni" className="text-xs">
                        {t("bridge.wytunnel.handshakeSni")}
                      </Label>
                      <Input
                        id="wt-hs-sni"
                        className="h-8 font-mono text-xs"
                        placeholder="edge.example.com"
                        value={handshakeSni}
                        onChange={(e) => setHandshakeSni(e.target.value)}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {t("bridge.wytunnel.handshakeSniHint")}
                      </p>
                    </div>
                  ) : null}

                  {handshakeMode === "http_ws_upgrade" ? (
                    <div className="space-y-2 rounded border bg-well/60 p-2.5">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="space-y-1">
                          <Label htmlFor="wt-ws-host" className="text-xs">
                            {t("bridge.wytunnel.handshakeHost")}
                          </Label>
                          <Input
                            id="wt-ws-host"
                            className="h-8 font-mono text-xs"
                            placeholder="ws.local"
                            value={handshakeSni}
                            onChange={(e) => setHandshakeSni(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="wt-ws-path" className="text-xs">
                            {t("bridge.wytunnel.handshakePath")}
                          </Label>
                          <Input
                            id="wt-ws-path"
                            className="h-8 font-mono text-xs"
                            placeholder="/ws"
                            value={handshakePath}
                            onChange={(e) => setHandshakePath(e.target.value)}
                          />
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {t("bridge.wytunnel.handshakeWsHint")}
                      </p>
                    </div>
                  ) : null}

                  {handshakeMode === "custom" ? (
                    <div className="space-y-1.5 rounded border bg-well/60 p-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label htmlFor="wt-hs-data" className="text-xs">
                          {t("bridge.wytunnel.handshakeData")}
                        </Label>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => setHandshakePacketData(TLS_HEADER_PRESET_BASE64)}
                        >
                          {t("bridge.wytunnel.handshakeDataPreset")}
                        </Button>
                      </div>
                      <Input
                        id="wt-hs-data"
                        className="h-8 font-mono text-xs"
                        placeholder={TLS_HEADER_PRESET_BASE64}
                        value={handshakePacketData}
                        onChange={(e) => setHandshakePacketData(e.target.value)}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {t("bridge.wytunnel.handshakeDataHint")}
                      </p>
                    </div>
                  ) : null}

                  <label className="flex items-center justify-between gap-2 text-xs">
                    <span>{t("bridge.wytunnel.ebpf")}</span>
                    <Switch checked={ebpfEnabled} onCheckedChange={setEbpfEnabled} />
                  </label>
                </div>
              </details>
            </div>
          ) : null}

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
              {busy ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

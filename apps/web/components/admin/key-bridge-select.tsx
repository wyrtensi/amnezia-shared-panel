"use client";

import * as React from "react";
import type { Bridge, KeyBridgeMode } from "@amnezia/contracts";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldHint, Hint } from "@/components/ui/hint";
import { bridgeEntry } from "@/lib/bridge-ui";
import { useT } from "@/lib/i18n/provider";

export type NodeBridgeOption = {
  routeId: string;
  bridgeId: string;
  bridgeName: string;
  publicIpv4: string;
  publicUdpPort: number;
  state: "active" | "draft" | "retiring";
};

const STATE_ORDER: Record<NodeBridgeOption["state"], number> = {
  active: 0,
  draft: 1,
  retiring: 2,
};

/** Flattens every held bridge route for `nodeId`, active first. */
export function bridgeOptionsForNode(
  bridges: readonly Bridge[],
  nodeId: string,
): NodeBridgeOption[] {
  const result: NodeBridgeOption[] = [];
  for (const bridge of bridges) {
    for (const route of bridge.routes) {
      if (route.nodeId !== nodeId) continue;
      result.push({
        routeId: route.id,
        bridgeId: bridge.id,
        bridgeName: bridge.name,
        publicIpv4: bridge.publicIpv4,
        publicUdpPort: route.publicUdpPort,
        state: route.state,
      });
    }
  }
  return result.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      a.bridgeName.localeCompare(b.bridgeName),
  );
}

/**
 * Admin-only bridge selector used when creating a key: inherit routing settings,
 * force Direct, or pin a specific bridge route configured on the target node.
 */
export function KeyBridgeSelect({
  nodeId,
  protocol,
  bridges,
  bridgeMode,
  routeId,
  onChange,
  idPrefix = "key-bridge",
}: {
  nodeId: string;
  protocol: string;
  bridges: readonly Bridge[];
  bridgeMode: KeyBridgeMode;
  routeId: string;
  onChange: (next: { bridgeMode: KeyBridgeMode; routeId: string }) => void;
  idPrefix?: string;
}) {
  const { t } = useT();
  const options = React.useMemo(
    () => (nodeId ? bridgeOptionsForNode(bridges, nodeId) : []),
    [bridges, nodeId],
  );
  const activeOption = options.find((item) => item.state === "active") ?? null;

  // Keep the selected route valid when the admin switches servers.
  React.useEffect(() => {
    if (bridgeMode !== "route") return;
    if (options.length === 0) {
      onChange({ bridgeMode: "inherit", routeId: "" });
      return;
    }
    if (!options.some((item) => item.routeId === routeId)) {
      onChange({
        bridgeMode: "route",
        routeId: activeOption?.routeId ?? options[0]!.routeId,
      });
    }
  }, [bridgeMode, routeId, options, activeOption, onChange]);

  if (protocol !== "awg3") return null;

  const stateLabel = (state: NodeBridgeOption["state"]) =>
    state === "active"
      ? t("keyBridge.routeActive")
      : state === "draft"
        ? t("keyBridge.routeDraft")
        : t("keyBridge.routeRetiring");

  return (
    <div className="space-y-2.5">
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={`${idPrefix}-mode`}>{t("keyBridge.label")}</Label>
          <Hint>{t("keyBridge.hint")}</Hint>
        </div>
        <Select
          value={bridgeMode}
          onValueChange={(value) => {
            const nextMode = value as KeyBridgeMode;
            const nextRoute =
              nextMode === "route"
                ? (options.find((item) => item.routeId === routeId)?.routeId ??
                  activeOption?.routeId ??
                  options[0]?.routeId ??
                  "")
                : "";
            onChange({ bridgeMode: nextMode, routeId: nextRoute });
          }}
        >
          <SelectTrigger id={`${idPrefix}-mode`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t("keyBridge.inherit")}</SelectItem>
            <SelectItem value="direct">{t("keyBridge.direct")}</SelectItem>
            <SelectItem value="route" disabled={options.length === 0}>
              {t("keyBridge.route")}
            </SelectItem>
          </SelectContent>
        </Select>
        {options.length === 0 ? (
          <FieldHint>{t("keyBridge.noRoutesOnNode")}</FieldHint>
        ) : null}
      </div>

      {bridgeMode === "route" && options.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-route`}>{t("keyBridge.selectBridge")}</Label>
          <Select
            value={routeId}
            onValueChange={(nextRoute) =>
              onChange({ bridgeMode: "route", routeId: nextRoute })
            }
          >
            <SelectTrigger id={`${idPrefix}-route`}>
              <SelectValue placeholder={t("keyBridge.selectBridgePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {options.map((item) => (
                <SelectItem key={item.routeId} value={item.routeId}>
                  {item.bridgeName} · {bridgeEntry(item.publicIpv4, item.publicUdpPort)} (
                  {stateLabel(item.state)})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  );
}

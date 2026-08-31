"use client";

import * as React from "react";
import {
  HardDrive,
  Laptop,
  Monitor,
  Smartphone,
  Tablet,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OptionCards, type CardOption } from "@/components/option-cards";
import { Hint, FieldHint } from "@/components/ui/hint";
import { useT } from "@/lib/i18n/provider";
import { suggestKeyName, type DeviceType } from "@/lib/suggest-key-name";
import type {
  Me,
  NodeView,
  ProtocolKind,
  RouteProfile,
  RouteProfileAvailability,
} from "@/lib/types";

const DEVICE_ICONS: Record<DeviceType, React.ReactNode> = {
  unspecified: <HardDrive />,
  desktop: <Monitor />,
  laptop: <Laptop />,
  iphone: <Smartphone />,
  android: <Smartphone />,
  phone: <Smartphone />,
  tablet: <Tablet />,
  other: <HardDrive />,
};

const DEVICE_ORDER: DeviceType[] = [
  "laptop",
  "desktop",
  "iphone",
  "android",
  "tablet",
  "other",
];

// AWG 3.1 is the project's primary protocol; prefer it whenever a node offers it.
const preferredProtocol = (protocols: ProtocolKind[]): ProtocolKind =>
  protocols.includes("awg3") ? "awg3" : (protocols[0] ?? "awg3");

// Show the recommended protocol first in the card grid.
const orderProtocols = (protocols: ProtocolKind[]): ProtocolKind[] =>
  [...protocols].sort((a, b) => (a === "awg3" ? -1 : b === "awg3" ? 1 : 0));

// Protocols a user may pick on a node: the server-computed selectable set
// (node-enabled ∩ policy-allowed), falling back gracefully for older payloads.
const nodeSelectableProtocols = (
  node: NodeView | undefined,
): ProtocolKind[] => {
  if (node?.selectableProtocols?.length) return node.selectableProtocols;
  if (node?.supportedProtocols?.length) return node.supportedProtocols;
  return node ? [node.protocol] : ["awg3"];
};

export type CreateKeyPayload = {
  nodeId: string;
  deviceType: DeviceType;
  deviceLabel: string;
  protocol: ProtocolKind;
  routeProfile: RouteProfile;
};

export function CreateKeyWizard({
  open,
  onOpenChange,
  me,
  nodes,
  routeProfiles,
  existingNames,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  me: Me;
  nodes: NodeView[];
  routeProfiles: RouteProfileAvailability[];
  existingNames: string[];
  onCreate: (payload: CreateKeyPayload) => Promise<void>;
}) {
  const { t } = useT();
  const [deviceType, setDeviceType] = React.useState<DeviceType>("laptop");
  const [deviceLabel, setDeviceLabel] = React.useState("");
  const [labelEdited, setLabelEdited] = React.useState(false);
  const [nodeId, setNodeId] = React.useState("");
  const [protocol, setProtocol] = React.useState<ProtocolKind>("awg3");
  const [routeProfile, setRouteProfile] =
    React.useState<RouteProfile>("full_tunnel");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  // Reset the form only when the wizard OPENS (open false→true) — not on every
  // `nodes`/`existingNames` change, or a background refresh (e.g. the
  // provisioning poll) would wipe the user's input mid-fill every few seconds.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      wasOpen.current = true;
      setDeviceType("laptop");
      setLabelEdited(false);
      setDeviceLabel(suggestKeyName("laptop", existingNames, t));
      setNodeId(nodes[0]?.id ?? "");
      setProtocol(preferredProtocol(nodeSelectableProtocols(nodes[0])));
      setRouteProfile("full_tunnel");
      setError("");
    } else if (!open) {
      wasOpen.current = false;
    }
  }, [open, nodes, existingNames, t]);

  const selectedNode = nodes.find((node) => node.id === nodeId) ?? nodes[0];
  const nodeProtocols: ProtocolKind[] = nodeSelectableProtocols(selectedNode);

  // Keep the selected protocol valid for the chosen node.
  React.useEffect(() => {
    if (!nodeProtocols.includes(protocol)) {
      setProtocol(preferredProtocol(nodeProtocols));
    }
  }, [nodeId, nodeProtocols, protocol]);

  const chooseDevice = (next: DeviceType) => {
    setDeviceType(next);
    if (!labelEdited) setDeviceLabel(suggestKeyName(next, existingNames, t));
  };

  const deviceOptions: Array<CardOption<DeviceType>> = DEVICE_ORDER.map(
    (type) => ({
      value: type,
      label: t(`device.${type}`),
      icon: DEVICE_ICONS[type],
    }),
  );

  const protocolOptions: Array<CardOption<ProtocolKind>> = orderProtocols(
    nodeProtocols,
  ).map((kind) => ({
    value: kind,
    label: t(`wizard.proto.${kind}.label`),
    description: t(`wizard.proto.${kind}.desc`),
    badge:
      kind === "awg3" ? (
        <Badge variant="success" className="ml-1">
          {t("wizard.recommended")}
        </Badge>
      ) : undefined,
    hint: kind === "awg3" ? t("wizard.awg3Hint") : undefined,
  }));

  const policyLocked = !me.policy.allowRouteProfileSelection;
  const routeOptions: Array<CardOption<RouteProfile>> = (
    ["full_tunnel", "ru_whitelist", "ru_blacklist"] as RouteProfile[]
  ).map((profile) => {
    const availability = routeProfiles.find((item) => item.profile === profile);
    const rulesReady = profile === "full_tunnel" || availability?.available;
    // A profile is selectable when its rules are active and the admin policy
    // permits choosing profiles (full_tunnel is always allowed).
    const disabled =
      !rulesReady || (policyLocked && profile !== "full_tunnel");
    return {
      value: profile,
      label: t(`route.${profile}`),
      description: t(`wizard.route.${profile}.desc`),
      disabled,
      hint: !rulesReady
        ? t("wizard.rulesNotActive")
        : policyLocked && profile !== "full_tunnel"
          ? t("wizard.profileDisabled")
          : undefined,
    };
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedNode) return;
    setBusy(true);
    setError("");
    try {
      await onCreate({
        nodeId: selectedNode.id,
        deviceType,
        deviceLabel: deviceLabel.trim(),
        protocol,
        routeProfile,
      });
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("wizard.createFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("wizard.title")}</DialogTitle>
          <DialogDescription>
            {t("wizard.desc")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-5">
          <div className="space-y-2">
            <Label>{t("wizard.deviceType")}</Label>
            <OptionCards
              options={deviceOptions}
              value={deviceType}
              onChange={chooseDevice}
              columns={3}
              ariaLabel={t("wizard.deviceType")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="device-label">{t("common.name")}</Label>
            <Input
              id="device-label"
              maxLength={80}
              placeholder={t("wizard.namePlaceholder")}
              value={deviceLabel}
              onChange={(event) => {
                setLabelEdited(true);
                setDeviceLabel(event.target.value);
              }}
            />
          </div>

          {me.policy.allowNodeSelection && nodes.length > 1 ? (
            <div className="space-y-2">
              <Label>{t("wizard.server")}</Label>
              <Select value={nodeId} onValueChange={setNodeId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("wizard.serverPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {node.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {protocolOptions.length > 1 ? (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Label>{t("wizard.protocol")}</Label>
                <Hint>{t("wizard.protocolHint")}</Hint>
              </div>
              <OptionCards
                options={protocolOptions}
                value={protocol}
                onChange={setProtocol}
                ariaLabel={t("wizard.protocol")}
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label>{t("wizard.routing")}</Label>
              <Hint>{t("wizard.routingHint")}</Hint>
            </div>
            <OptionCards
              options={routeOptions}
              value={routeProfile}
              onChange={setRouteProfile}
              columns={3}
              ariaLabel={t("wizard.routing")}
            />
            {policyLocked ? (
              <FieldHint>{t("wizard.routingLocked")}</FieldHint>
            ) : null}
          </div>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !selectedNode}>
              {busy ? t("wizard.creating") : t("wizard.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

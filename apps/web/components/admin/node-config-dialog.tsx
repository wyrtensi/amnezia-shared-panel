"use client";

import * as React from "react";
import { ListTree, Settings2 } from "lucide-react";
import { resolveAwgClientSettings, type AwgDeviceRules, type AwgGeneratorSettings } from "@amnezia/contracts";
import { addressRulesInherited, DeviceRulesEditor } from "@/components/admin/awg-device-rules-editor";
import { ClientParametersDialog, type ClientParametersTarget } from "@/components/admin/client-parameters-dialog";
import {
  GeneratorEditor,
  usePresetLabel,
  type GeneratorEndpoint,
} from "@/components/admin/node-generator-settings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/provider";

/** The target picker's value for the node itself; an item value cannot be empty. */
const NODE_SCOPE = "node";

type Props = {
  /** The node, for its parameters view; without it the view is not offered. */
  nodeId?: string;
  value: AwgGeneratorSettings | null;
  /** The node's own client MTU; null inherits the default. */
  mtu?: number | null;
  endpoints: readonly GeneratorEndpoint[];
  onSave: (endpointId: string | null, settings: AwgGeneratorSettings | null, mtu: number | null) => Promise<void>;
  onSaveDeviceRules: (endpointId: string, rules: AwgDeviceRules | null) => Promise<void>;
};

export function NodeGeneratorSettings({ nodeId, value, mtu = null, endpoints, onSave, onSaveDeviceRules }: Props) {
  const { t } = useT();
  const presetLabel = usePresetLabel();
  const [open, setOpen] = React.useState(false);
  const [scope, setScope] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [parameters, setParameters] = React.useState<ClientParametersTarget | null>(null);
  const pendingRef = React.useRef(false);
  const selected = endpoints.find((endpoint) => endpoint.id === scope);
  const node = resolveAwgClientSettings({ node: { awgGenerator: value, awgMtu: mtu } });
  const address = selected
    ? resolveAwgClientSettings({ address: selected, node: { awgGenerator: value, awgMtu: mtu } })
    : null;
  const run = async (work: () => Promise<void>): Promise<boolean> => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    try {
      await work();
      return true;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => {
          if (pendingRef.current) return;
          setScope("");
          setOpen(true);
        }}
      >
        <Settings2 className="size-4" /> {t("generator.title")}
      </Button>
      <Dialog open={open} onOpenChange={(next) => {
        if (!pendingRef.current) setOpen(next);
      }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("generator.title")}</DialogTitle>
            <DialogDescription>{t("generator.description")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="generator-target">{t("generator.target")}</Label>
            <div className="flex items-center gap-2">
            <Select
              value={scope || NODE_SCOPE}
              disabled={pending}
              onValueChange={(next) => {
                if (!pendingRef.current) setScope(next === NODE_SCOPE ? "" : next);
              }}
            >
              <SelectTrigger id="generator-target" className="min-w-0 flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NODE_SCOPE}>{t("generator.node")}</SelectItem>
                {endpoints.map((endpoint) => (
                  <SelectItem key={endpoint.id} value={endpoint.id}>{endpoint.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {nodeId ? (
              <Button
                type="button" variant="outline" size="sm" className="shrink-0"
                disabled={pending}
                title={t("clientParams.nodeAction", { name: selected?.name ?? t("generator.node") })}
                onClick={() => {
                  if (pendingRef.current) return;
                  setParameters({
                    kind: "node",
                    id: nodeId,
                    endpointId: selected?.id ?? null,
                    label: selected?.name ?? t("generator.node"),
                  });
                }}
              >
                <ListTree className="size-4" /> {t("clientParams.open")}
              </Button>
            ) : null}
            </div>
          </div>
          <GeneratorEditor
            key={`${open}-${scope}`}
            value={scope ? selected?.awgGenerator ?? null : value}
            mtu={scope ? selected?.awgMtu ?? null : mtu}
            inheritLabel={scope
              ? t("awgSettings.inheritFrom", { source: t("awgSettings.from.node"), profile: presetLabel(node.awgGenerator) })
              : t("generator.inheritDefault")}
            inheritedMtu={scope
              ? { mtu: node.mtu, source: node.mtuFrom, profile: node.awgGenerator }
              : { mtu: 1280, source: "default", profile: null }}
            pending={pending}
            onSave={(settings, ownMtu) => run(async () => {
              await onSave(scope || null, settings, ownMtu);
              setOpen(false);
            })}
          />
          {selected && address ? (
            <DeviceRulesEditor
              key={`rules-${open}-${scope}`}
              rules={selected.awgDeviceRules ?? null}
              inherited={addressRulesInherited(address, presetLabel)}
              pending={pending}
              onSave={(rules) => run(() => onSaveDeviceRules(selected.id, rules))}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ClientParametersDialog target={parameters} onClose={() => setParameters(null)} />
    </>
  );
}

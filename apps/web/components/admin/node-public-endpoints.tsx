"use client";

import * as React from "react";
import { Globe, ListTree, Pencil, Plus, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { AdminNodeEndpoint, NodePublicEndpointMutation } from "@amnezia/contracts";
import { ClientParametersDialog, type ClientParametersTarget } from "@/components/admin/client-parameters-dialog";
import { NodeCardSection } from "@/components/admin/node-card-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatEntryExit } from "@/lib/egress-api";
import { useT } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

export function NodePublicEndpoints({
  endpoints,
  canAdd,
  onSave,
  parametersNodeId,
}: {
  endpoints: readonly AdminNodeEndpoint[];
  canAdd: boolean;
  /** The AWG 3.1 node these addresses belong to; each row then opens its client parameters. */
  parametersNodeId?: string;
  onSave: (change: NodePublicEndpointMutation) => Promise<void>;
}) {
  const { t } = useT();
  const [editor, setEditor] = React.useState<"new" | AdminNodeEndpoint | null>(null);
  const [address, setAddress] = React.useState("");
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [parameters, setParameters] = React.useState<ClientParametersTarget | null>(null);

  const save = async (change: NodePublicEndpointMutation) => {
    setBusy(true);
    try {
      await onSave(change);
      setEditor(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("nodes.updateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const open = (value: "new" | AdminNodeEndpoint) => {
    setEditor(value);
    setAddress("");
    setName(value === "new" ? "" : value.name);
  };

  if (!canAdd && endpoints.length === 0) return null;

  const enabledCount = endpoints.filter((endpoint) => endpoint.enabled).length;

  return (
    <section className="space-y-1.5">
      <NodeCardSection
        icon={Globe}
        action={
          canAdd ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={busy}
              onClick={() => open("new")}
            >
              <Plus className="size-3.5" />
              {t("nodes.addEndpoint")}
            </Button>
          ) : null
        }
      >
        {t("nodes.endpoints")}
      </NodeCardSection>
      <ul className="space-y-1.5">
        {endpoints.map((endpoint) => {
          const state = endpoint.reachability?.state;
          const isLastEnabled = endpoint.enabled && enabledCount <= 1;
          const statusBadge = !endpoint.enabled
            ? { variant: "outline" as const, key: "nodes.endpointDisabled" }
            : !endpoint.reachabilityEnabled
              ? { variant: "outline" as const, key: "reachability.excluded" }
              : state === "ok"
                ? { variant: "success" as const, key: "nodes.endpointProbeOk" }
                : state === "blocked"
                  ? { variant: "destructive" as const, key: "nodes.endpointProbeBlocked" }
                  : { variant: "outline" as const, key: "nodes.endpointProbeUnknown" };
          return (
            <li
              key={endpoint.id}
              className={cn(
                "space-y-1 rounded-md border border-border/60 bg-well px-2.5 py-2 shadow-[var(--inset-shadow)]",
                !endpoint.enabled && "opacity-65",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{endpoint.name}</span>
                  {endpoint.ordinal === 1 ? (
                    <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                      {t("nodes.endpointPrimary")}
                    </Badge>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {parametersNodeId ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-foreground"
                      aria-label={t("clientParams.nodeAction", { name: endpoint.name })}
                      title={t("clientParams.nodeAction", { name: endpoint.name })}
                      onClick={() => setParameters({
                        kind: "node", id: parametersNodeId, endpointId: endpoint.id, label: endpoint.name,
                      })}
                    >
                      <ListTree className="size-3.5" />
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    disabled={busy}
                    aria-label={t("nodes.editEndpoint", { name: endpoint.name })}
                    title={t("nodes.editEndpoint", { name: endpoint.name })}
                    onClick={() => open(endpoint)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Switch
                    checked={endpoint.enabled}
                    disabled={busy || isLastEnabled}
                    aria-label={t(
                      endpoint.enabled ? "nodes.endpointToggleOff" : "nodes.endpointToggleOn",
                      { name: endpoint.name },
                    )}
                    title={
                      isLastEnabled
                        ? t("nodes.endpointLastEnabledHint")
                        : t(endpoint.enabled ? "nodes.endpointToggleOffTip" : "nodes.endpointToggleOnTip")
                    }
                    onCheckedChange={(checked) =>
                      void save({ action: "update", id: endpoint.id, enabled: checked })
                    }
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <code className="font-mono text-xs text-muted-foreground">
                  {formatEntryExit(endpoint.publicAddress, endpoint.effectiveEgressIp) ?? endpoint.publicAddress}
                </code>
                <div className="flex flex-wrap items-center gap-1">
                  <Badge
                    variant={statusBadge.variant}
                    title={endpoint.probeDetail ?? endpoint.probeCheckedAt ?? undefined}
                  >
                    {t(statusBadge.key)}
                  </Badge>
                  {endpoint.probeEgressMatch === false ? (
                    <Badge variant="destructive">
                      {t("reachability.egressMismatch")}
                    </Badge>
                  ) : null}
                  {endpoint.incidentOpen ? (
                    <Badge variant="destructive">
                      <TriangleAlert className="h-3 w-3" /> {t("reachability.incident")}
                    </Badge>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {editor ? (
        <form
          className="space-y-2 rounded-md border border-border/60 bg-card p-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save(
              editor === "new"
                ? { action: "add", address: address.trim(), name: name.trim() || undefined }
                : { action: "update", id: editor.id, name: name.trim() },
            );
          }}
        >
          {editor === "new" ? (
            <Input
              aria-label={t("nodes.endpointIpv4")}
              placeholder={t("nodes.endpointIpv4")}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              required
            />
          ) : null}
          <Input
            aria-label={t("common.name")}
            placeholder={t("nodes.endpointNamePlaceholder")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required={editor !== "new"}
          />
          <div className="flex justify-end gap-1">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditor(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      ) : null}
      <ClientParametersDialog target={parameters} onClose={() => setParameters(null)} />
    </section>
  );
}

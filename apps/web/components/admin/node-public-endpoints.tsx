"use client";

import * as React from "react";
import { toast } from "sonner";
import type { AdminNodeEndpoint, NodePublicEndpointMutation } from "@amnezia/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/provider";

export function NodePublicEndpoints({
  endpoints,
  canAdd,
  onSave,
}: {
  endpoints: readonly AdminNodeEndpoint[];
  canAdd: boolean;
  onSave: (change: NodePublicEndpointMutation) => Promise<void>;
}) {
  const { t } = useT();
  const [editor, setEditor] = React.useState<"new" | AdminNodeEndpoint | null>(null);
  const [address, setAddress] = React.useState("");
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);

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

  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">{t("nodes.endpoints")}</h3>
        {canAdd ? (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => open("new")}>
            {t("nodes.addEndpoint")}
          </Button>
        ) : null}
      </div>
      {endpoints.map((endpoint) => {
        const state = endpoint.reachability?.state;
        const label = !endpoint.enabled ? "nodes.stopped"
          : state === "ok" ? "emp.serverOk"
            : state === "blocked" ? "emp.serverBlocked" : "emp.serverUnknown";
        return (
          <div key={endpoint.id} className="flex flex-wrap items-center justify-between gap-1 rounded-md border border-border/60 bg-well px-2 py-1">
            <div className="min-w-0">
              <div className="truncate text-sm">{endpoint.name}</div>
              <code className="block text-xs text-muted-foreground">{endpoint.publicAddress}</code>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Badge variant={state === "ok" ? "success" : state === "blocked" ? "destructive" : "outline"}
                title={endpoint.probeDetail ?? endpoint.probeCheckedAt ?? undefined}>
                {t(label)}
              </Badge>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => open(endpoint)}>
                {t("common.edit")}
              </Button>
              {endpoint.ordinal > 1 ? (
                <Button type="button" variant="ghost" size="sm" disabled={busy}
                  onClick={() => void save({ action: "update", id: endpoint.id, enabled: !endpoint.enabled })}>
                  {t(endpoint.enabled ? "nodes.toggleOff" : "nodes.toggleOn")}
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
      {editor ? (
        <form className="space-y-2" onSubmit={(event) => {
          event.preventDefault();
          void save(editor === "new"
            ? { action: "add", address: address.trim(), name: name.trim() || undefined }
            : { action: "update", id: editor.id, name: name.trim() });
        }}>
          {editor === "new" ? (
            <Input aria-label={t("nodes.endpointIpv4")} placeholder={t("nodes.endpointIpv4")}
              value={address} onChange={(event) => setAddress(event.target.value)} required />
          ) : null}
          <Input aria-label={t("common.name")} placeholder={t("nodes.endpointNamePlaceholder")}
            value={name} onChange={(event) => setName(event.target.value)}
            maxLength={120} required={editor !== "new"} />
          <div className="flex justify-end gap-1">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditor(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy}>{t("common.save")}</Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

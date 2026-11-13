"use client";

import * as React from "react";
import Link from "next/link";
import { Cable, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  BRIDGE_DEFAULT_CONTROL_TCP_PORT,
  BRIDGE_DEFAULT_UDP_PORT_END,
  BRIDGE_DEFAULT_UDP_PORT_START,
  type Bridge,
} from "@amnezia/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useAdminData } from "@/components/admin/admin-data";
import type { BridgeInfra } from "@/components/admin/use-bridge-infra";
import { createBridge, deleteBridge, renameBridge } from "@/lib/bridge-api";
import {
  describeBridgeError,
  nodeRouteEditorHref,
  poolCapacity,
  registrationTone,
  verificationLabelKey,
  verificationTime,
  verificationTone,
} from "@/lib/bridge-ui";
import { formatDateTime } from "@/lib/format";
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
}: {
  bridge: Bridge;
  t: Translate;
  lang: Lang;
  onRename: () => void;
  onDelete: () => void;
}) {
  const free = Math.max(0, bridge.capacity - bridge.heldPorts);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium leading-tight">{bridge.name}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {bridge.publicIpv4}
            </p>
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

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={STATUS_VARIANT[bridge.managementStatus]}>
            {t(`bridge.status.${bridge.managementStatus}`)}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {bridge.lastObservedAt
              ? t("bridge.lastObserved", {
                  at: formatDateTime(bridge.lastObservedAt, lang),
                })
              : t("bridge.neverObserved")}
          </span>
        </div>

        <BridgeManagementView bridge={bridge} t={t} lang={lang} />

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{t("bridge.controlPort")}</dt>
          <dd className="font-mono">{bridge.controlTcpPort}/tcp</dd>
          <dt className="text-muted-foreground">{t("bridge.udpRange")}</dt>
          <dd className="font-mono">
            {bridge.udpPortStart}–{bridge.udpPortEnd}/udp
          </dd>
          <dt className="text-muted-foreground">{t("bridge.ports")}</dt>
          <dd>{t("bridge.portsUsed", { used: bridge.heldPorts, total: bridge.capacity, free })}</dd>
        </dl>

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
                  <span className="min-w-0 truncate font-medium">{route.nodeName}</span>
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

        {bridge.setupCommands ? (
          <details className="rounded-md border px-2 py-1.5">
            <summary className="cursor-pointer text-xs font-medium">
              {t("bridge.hostSetup")}
            </summary>
            <div className="mt-2 space-y-2">
              <p className="text-xs text-muted-foreground">{t("bridge.hostSetupHint")}</p>
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

/**
 * The bridge-agent's side of the card: version, frps and the last poll.
 * Presentational and free of secrets: the enrollment credential is never part
 * of the bridge payload.
 */
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
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted-foreground">{t("bridge.mgmt.agent")}</dt>
      <dd className="font-mono">{management.agentVersion ?? t("bridge.unknown")}</dd>
      <dt className="text-muted-foreground">{t("bridge.mgmt.frps")}</dt>
      <dd>{frps}</dd>
      <dt className="text-muted-foreground">{t("bridge.mgmt.lastOk")}</dt>
      <dd>{when(bridge.lastObservedAt)}</dd>
      <dt className="text-muted-foreground">{t("bridge.mgmt.lastPoll")}</dt>
      <dd>{when(management.lastPollAttemptAt)}</dd>
      {management.lastErrorCode ? (
        <>
          <dt className="text-muted-foreground">{t("bridge.mgmt.problem")}</dt>
          <dd className="break-all font-mono text-destructive">{management.lastErrorCode}</dd>
        </>
      ) : null}
    </dl>
  );
}

function EvidenceTime({ at, lang }: { at: string | null; lang: Lang }) {
  return at ? (
    <span className="text-muted-foreground">{formatDateTime(at, lang)}</span>
  ) : null;
}

export function BridgesTab({ infra }: { infra: BridgeInfra }) {
  const { t, lang } = useT();
  const { request } = useAdminData();
  const [showAdd, setShowAdd] = React.useState(false);
  const [renaming, setRenaming] = React.useState<Bridge | null>(null);
  const [deleting, setDeleting] = React.useState<Bridge | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Cable className="h-4 w-4 text-primary" />
            {t("bridge.title")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("bridge.intro")}</p>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4" /> {t("bridge.add")}
        </Button>
      </div>

      {infra.failed ? (
        <Callout tone="danger">{t("bridge.loadFailed")}</Callout>
      ) : null}

      {infra.loading && infra.bridges.length === 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-56 rounded-xl" />
          ))}
        </div>
      ) : infra.bridges.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <h3 className="text-base font-semibold">{t("bridge.empty")}</h3>
            <p className="max-w-sm text-sm text-muted-foreground">
              {t("bridge.emptyHint")}
            </p>
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
      <DeleteBridgeDialog
        bridge={deleting}
        onClose={() => setDeleting(null)}
        onDone={infra.reload}
        request={request}
      />
    </div>
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
      await createBridge(request, {
        name: name.trim(),
        publicIpv4: ip.trim(),
        controlTcpPort: Number(controlPort),
        udpPortStart: Number(udpStart),
        udpPortEnd: Number(udpEnd),
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
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setName(bridge?.name ?? "");
    setError(null);
  }, [bridge]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      await renameBridge(request, bridge.id, name.trim());
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
          <Input
            aria-label={t("common.name")}
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
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

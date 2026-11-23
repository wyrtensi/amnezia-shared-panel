"use client";

import * as React from "react";
import { AlertTriangle, Check, Copy, Pin, RotateCw, ServerCog } from "lucide-react";
import { toast } from "sonner";
import {
  deviceRuleFor,
  type AdminClientParameters,
  type AwgClientParameter,
  type AwgClientParameterName,
  type AwgDeviceRules,
  type AwgGeneratorSettings,
} from "@amnezia/contracts";
import { useAdminData } from "@/components/admin/admin-data";
import { deviceRuleRows } from "@/components/admin/awg-device-rules-editor";
import { AwgSourcedSettings } from "@/components/admin/awg-mtu-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Callout } from "@/components/ui/hint";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiClientError, apiRequest } from "@/lib/api";
import { deviceTypeLabel } from "@/lib/device-type";
import { useT } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/** Whose parameters to show: a key, or a node (`endpointId` null) or one of its addresses. */
export type ClientParametersTarget =
  | { kind: "key"; id: string; label?: string }
  | { kind: "node"; id: string; endpointId: string | null; label?: string };

export const clientParametersPath = (target: ClientParametersTarget): string =>
  target.kind === "key"
    ? `/api/admin/keys/${encodeURIComponent(target.id)}/client-parameters`
    : `/api/admin/nodes/${encodeURIComponent(target.id)}/client-parameters${
      target.endpointId ? `?endpointId=${encodeURIComponent(target.endpointId)}` : ""
    }`;

const GROUPS: ReadonlyArray<{ id: ParameterGroupId; names: readonly AwgClientParameterName[] }> = [
  { id: "junk", names: ["Jc", "Jmin", "Jmax"] },
  { id: "server", names: ["S1", "S2", "S3", "S4", "H1", "H2", "H3", "H4"] },
  { id: "signature", names: ["I1", "I2", "I3", "I4", "I5"] },
  {
    id: "timings",
    names: [
      "ContentPaddingAddition",
      "RekeyAfterTime", "RekeyTimeout", "RejectAfterTime", "KeepaliveTimeout", "MaxHandshakeAttempts",
    ],
  },
  { id: "mtu", names: ["MTU"] },
];

export type ParameterGroupId = "junk" | "server" | "signature" | "timings" | "mtu";

/** One parameter as exported, and as the node issued it when that differs. */
export type ParameterRow = AwgClientParameter & { issued: string | null; differs: boolean };

export type ParameterGroup = {
  id: ParameterGroupId;
  /** Every row is the server's: set by the node, never by a client profile. */
  server: boolean;
  rows: ParameterRow[];
};

/** The parameters in display groups, each exported value next to the issued one. */
export const parameterGroups = (data: Pick<AdminClientParameters, "exported" | "issued">): ParameterGroup[] => {
  const issued = new Map(data.issued.map((parameter) => [parameter.name, parameter.value]));
  return GROUPS.map((group) => {
    const rows = data.exported
      .filter((parameter) => group.names.includes(parameter.name))
      .map((parameter) => {
        const was = issued.get(parameter.name) ?? null;
        return { ...parameter, issued: was, differs: was !== parameter.value };
      });
    return { id: group.id, server: rows.length > 0 && rows.every((row) => row.scope === "server"), rows };
  }).filter((group) => group.rows.length > 0);
};

/** A preset id as its label; null is a config without any profile (as the node issued it). */
const usePresetIdLabel = () => {
  const { t } = useT();
  return (preset: string | null) => (preset ? t(`generator.${preset}`) : t("awgSettings.noProfile"));
};

/** The header line: the profile and the MTU the config is built with, each with its level. */
export function ClientParametersSummary({ settings, className }: {
  settings: AdminClientParameters["settings"];
  className?: string;
}) {
  const presetLabel = usePresetIdLabel();
  return (
    <AwgSourcedSettings
      className={cn("text-sm", className)}
      profile={presetLabel(settings.preset)}
      profileSource={settings.profileFrom ?? "default"}
      mtu={settings.mtu}
      mtuSource={settings.mtuFrom}
    />
  );
}

function CopyValueButton({ name, value }: { name: string; value: string }) {
  const { t } = useT();
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(t("clientParams.copied", { name }));
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error(t("config.copyFailed"));
    }
  };
  const label = t("clientParams.copy", { name });
  return (
    <Button
      type="button" size="icon" variant="ghost"
      className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={label} title={label}
      onClick={() => void copy()}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

/**
 * The parameters in compact two-column groups. Long signature templates wrap
 * in their own scrolling cell with a copy button, so the page never scrolls
 * sideways; a value that differs from what the node issued shows the issued
 * one muted under it.
 */
export function ClientParametersTable({ data }: { data: Pick<AdminClientParameters, "exported" | "issued"> }) {
  const { t } = useT();
  const groups = parameterGroups(data);
  const anyDiffers = groups.some((group) => group.rows.some((row) => row.differs));
  return (
    <div className="space-y-4">
      {anyDiffers ? <p className="text-xs text-muted-foreground">{t("clientParams.issuedLegend")}</p> : null}
      {groups.map((group) => {
        const template = group.id === "signature";
        return (
          <section key={group.id} className="space-y-1.5" aria-labelledby={`client-params-${group.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h3
                id={`client-params-${group.id}`}
                className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {t(`clientParams.group.${group.id}`)}
              </h3>
              {group.server ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      <ServerCog className="mr-1 size-3" />
                      {t("clientParams.serverScope")}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{t("clientParams.serverScopeTip")}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <dl className="divide-y divide-border/60 rounded-lg border bg-well shadow-[var(--inset-shadow)]">
              {group.rows.map((row) => (
                <div
                  key={row.name}
                  className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-x-3 px-3 py-1.5 sm:grid-cols-[12rem_minmax(0,1fr)]"
                >
                  <dt className="break-all pt-0.5 font-mono text-xs text-muted-foreground">{row.name}</dt>
                  <dd className="min-w-0">
                    <div className="flex items-start gap-1">
                      {row.value === null ? (
                        <span className="pt-0.5 text-sm text-muted-foreground">—</span>
                      ) : (
                        <code
                          className={cn(
                            "min-w-0 flex-1 break-all pt-0.5 font-mono text-xs leading-5 text-foreground",
                            template && "max-h-40 overflow-y-auto whitespace-pre-wrap",
                          )}
                        >
                          {row.value}
                        </code>
                      )}
                      {template && row.value !== null ? <CopyValueButton name={row.name} value={row.value} /> : null}
                    </div>
                    {row.differs ? (
                      <p
                        className={cn(
                          "mt-0.5 break-all font-mono text-[11px] leading-4 text-muted-foreground",
                          template && "max-h-24 overflow-y-auto",
                        )}
                      >
                        {t("clientParams.issued", { value: row.issued ?? "—" })}
                      </p>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}

export type ClientParametersState =
  | { status: "loading" }
  | { status: "ready"; data: AdminClientParameters }
  | { status: "error"; code: string; message: string };

/** Loading, the errors that need words of their own, or the table. */
export function ClientParametersBody({ state, onRetry }: { state: ClientParametersState; onRetry: () => void }) {
  const { t } = useT();
  if (state.status === "loading") {
    return (
      <div aria-busy="true" className="space-y-4">
        <span className="sr-only">{t("clientParams.loading")}</span>
        {[3, 4, 2].map((rows, index) => (
          <div key={index} className="space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <div className="space-y-1 rounded-lg border bg-well p-3 shadow-[var(--inset-shadow)]">
              {Array.from({ length: rows }, (_, row) => <Skeleton key={row} className="h-4 w-full" />)}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (state.status === "error") {
    if (state.code === "SAMPLE_KEY_NOT_FOUND") {
      return (
        <Callout tone="info" icon={<ServerCog className="size-4 text-chart-4" />}>
          {t("clientParams.noSampleKey")}
        </Callout>
      );
    }
    if (state.code === "AWG_GENERATOR_UNSUPPORTED" || state.code === "KEY_NOT_FOUND") {
      return (
        <Callout tone="warning" icon={<AlertTriangle className="size-4 text-warning" />}>
          {t(state.code === "KEY_NOT_FOUND" ? "clientParams.keyNotFound" : "clientParams.unsupported")}
        </Callout>
      );
    }
    return (
      <Callout
        tone="danger"
        icon={<AlertTriangle className="size-4 text-destructive" />}
        title={t("clientParams.loadFailed")}
        action={(
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            <RotateCw className="size-4" /> {t("clientParams.retry")}
          </Button>
        )}
      >
        {state.message}
      </Callout>
    );
  }
  return <ClientParametersTable data={state.data} />;
}

export type PinTarget = "user" | "device";

/** The owner's settings a pin would overwrite. */
export type PinOwner = {
  awgGenerator?: AwgGeneratorSettings | null;
  awgMtu?: number | null;
  awgDeviceRules?: AwgDeviceRules | null;
};

/** What a pin writes and what it replaces, as the confirm step words it. */
export type PinPlan = {
  target: PinTarget;
  deviceType: string;
  /** Always both fields, as concrete values; no profile pins as "issued". */
  writes: { preset: string; mtu: number };
  /** What the target holds now (null fields inherit), or null when nothing is set there. */
  replaces: { preset: string | null; mtu: number | null } | null;
  /** Which of the written values come from the key's own override. */
  fromKey: { profile: boolean; mtu: boolean };
  /** Device types whose own user rule keeps applying after a user pin. */
  keptTypes: string[];
};

/** The same pin the server writes (`pin-config`), described before it is sent. */
export const pinPlan = (
  target: PinTarget,
  settings: AdminClientParameters["settings"],
  owner: PinOwner,
): PinPlan => {
  const held = target === "user"
    ? { awgGenerator: owner.awgGenerator ?? null, awgMtu: owner.awgMtu ?? null }
    : deviceRuleFor(owner.awgDeviceRules ?? null, settings.deviceType);
  return {
    target,
    deviceType: settings.deviceType,
    writes: { preset: settings.preset ?? "issued", mtu: settings.mtu },
    replaces: held && (held.awgGenerator !== null || held.awgMtu !== null)
      ? { preset: held.awgGenerator?.preset ?? null, mtu: held.awgMtu }
      : null,
    fromKey: { profile: settings.profileFrom === "key", mtu: settings.mtuFrom === "key" },
    keptTypes: target === "user" ? deviceRuleRows(owner.awgDeviceRules ?? null).set : [],
  };
};

/** The two pins of a key; a key without a device type has no rule to pin to. */
export function KeyPinActions({ settings, pending, onPick }: {
  settings: AdminClientParameters["settings"];
  pending: boolean;
  onPick: (target: PinTarget) => void;
}) {
  const { t } = useT();
  const typed = settings.deviceType !== "unspecified";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => onPick("user")}>
          <Pin className="size-4" /> {t("awgPin.user")}
        </Button>
        {typed ? (
          <Button
            type="button" size="sm" variant="outline" disabled={pending}
            className="h-auto min-h-8 whitespace-normal py-1.5 text-left"
            onClick={() => onPick("device")}
          >
            <Pin className="size-4" />
            {t("awgPin.device", { device: deviceTypeLabel(t, settings.deviceType) })}
          </Button>
        ) : null}
      </div>
      {typed ? null : <p className="text-xs text-muted-foreground">{t("awgPin.deviceUnavailable")}</p>}
    </div>
  );
}

/** The confirm step: what is written, what it replaces and who keeps their own rule. */
export function PinConfirm({ plan, pending, onConfirm, onCancel }: {
  plan: PinPlan;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const presetLabel = usePresetIdLabel();
  const device = deviceTypeLabel(t, plan.deviceType);
  const inherits = t("awgSettings.inherits");
  return (
    <div
      role="group"
      aria-labelledby="pin-confirm-title"
      className="space-y-2 rounded-lg border bg-well px-3 py-2.5 shadow-[var(--inset-shadow)]"
    >
      <p id="pin-confirm-title" className="text-sm font-medium">
        {plan.target === "user" ? t("awgPin.confirmUser") : t("awgPin.confirmDevice", { device })}
      </p>
      <ul className="space-y-1 text-sm">
        <li>{t("awgPin.writes", { profile: presetLabel(plan.writes.preset), mtu: plan.writes.mtu })}</li>
        <li className="text-muted-foreground">
          {plan.replaces
            ? t("awgPin.replaces", {
              profile: plan.replaces.preset ? presetLabel(plan.replaces.preset) : inherits,
              mtu: plan.replaces.mtu ?? inherits,
            })
            : t("awgPin.replacesNothing")}
        </li>
        {plan.fromKey.profile ? <li className="text-muted-foreground">{t("awgPin.fromKeyProfile")}</li> : null}
        {plan.fromKey.mtu ? <li className="text-muted-foreground">{t("awgPin.fromKeyMtu")}</li> : null}
        {plan.keptTypes.length > 0 ? (
          <li className="text-muted-foreground">
            {t("awgPin.keptTypes", { types: plan.keptTypes.map((type) => deviceTypeLabel(t, type)).join(", ") })}
          </li>
        ) : null}
      </ul>
      <p className="text-xs text-muted-foreground">{t("awgPin.reimport")}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" size="sm" disabled={pending} onClick={onConfirm}>
          <Pin className="size-4" /> {t("awgPin.confirm")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The key's pins, under its parameters. Only for an owner the users list
 * knows: the service account is not there, and the server refuses it anyway.
 */
function KeyPinSection({ keyId, settings, onPinned }: {
  keyId: string;
  settings: AdminClientParameters["settings"];
  onPinned: () => void;
}) {
  const { t } = useT();
  const { users, request, reload } = useAdminData();
  const [picked, setPicked] = React.useState<PinTarget | null>(null);
  const [pending, setPending] = React.useState(false);
  const owner = users.find((user) => user.id === settings.ownerId);
  if (!owner) return null;
  const pin = async (target: PinTarget) => {
    setPending(true);
    try {
      const result = await request<{ changed?: boolean } | undefined>(
        `/api/admin/keys/${encodeURIComponent(keyId)}/pin-config`,
        { method: "POST", body: JSON.stringify({ target }) },
      );
      toast.success(t(result?.changed === false ? "awgPin.unchanged" : "awgPin.done"));
      setPicked(null);
      await reload();
      onPinned();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("adminData.actionFailed"));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="space-y-2 border-t pt-4" aria-labelledby="key-pin-title">
      <h3 id="key-pin-title" className="text-sm font-medium">{t("awgPin.title")}</h3>
      <p className="text-xs text-muted-foreground">{t("awgPin.hint")}</p>
      {picked ? (
        <PinConfirm
          plan={pinPlan(picked, settings, owner)}
          pending={pending}
          onConfirm={() => void pin(picked)}
          onCancel={() => setPicked(null)}
        />
      ) : (
        <KeyPinActions settings={settings} pending={pending} onPick={setPicked} />
      )}
    </section>
  );
}

/**
 * The client Interface parameters a key's download carries now, or what the
 * probe's service key gets on a node or address. Read-only; a key's view also
 * offers to pin its settings to the owner.
 */
export function ClientParametersDialog({ target, onClose, onPinned }: {
  target: ClientParametersTarget | null;
  onClose: () => void;
  onPinned?: () => void;
}) {
  const { t } = useT();
  // The last target stays on screen while the dialog animates closed.
  const [shown, setShown] = React.useState(target);
  if (target && target !== shown) setShown(target);
  const path = target ? clientParametersPath(target) : null;
  const [loaded, setLoaded] = React.useState<{ path: string; state: ClientParametersState } | null>(null);
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    if (!path) return;
    let active = true;
    apiRequest<AdminClientParameters>(path).then(
      (data) => { if (active) setLoaded({ path, state: { status: "ready", data } }); },
      (error: unknown) => {
        if (!active) return;
        setLoaded({
          path,
          state: {
            status: "error",
            code: error instanceof ApiClientError ? error.code : "REQUEST_FAILED",
            message: error instanceof Error ? error.message : "",
          },
        });
      },
    );
    return () => { active = false; };
  }, [path, revision]);
  // A refetch keeps the current table until the new one arrives; another target starts from loading.
  const state: ClientParametersState = loaded && loaded.path === path ? loaded.state : { status: "loading" };
  const retry = () => {
    setLoaded(null);
    setRevision((value) => value + 1);
  };
  return (
    <Dialog open={Boolean(target)} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="pr-6 leading-tight">
            {t("clientParams.title")}
            {shown?.label ? <span className="font-normal text-muted-foreground"> · {shown.label}</span> : null}
          </DialogTitle>
          <DialogDescription>
            {t(shown?.kind === "node" ? "clientParams.nodeDescription" : "clientParams.keyDescription")}
          </DialogDescription>
          {state.status === "ready" ? <ClientParametersSummary settings={state.data.settings} className="pt-1" /> : null}
        </DialogHeader>
        <ClientParametersBody state={state} onRetry={retry} />
        {state.status === "ready" && shown?.kind === "key" && state.data.settings.ownerId ? (
          <KeyPinSection
            keyId={shown.id}
            settings={state.data.settings}
            onPinned={() => {
              setRevision((value) => value + 1);
              onPinned?.();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

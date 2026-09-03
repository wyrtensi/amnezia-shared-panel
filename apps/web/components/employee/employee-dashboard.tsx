"use client";

import * as React from "react";
import Link from "next/link";
import { CircleHelp, KeyRound, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import type { GuideAudience } from "@amnezia/contracts";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { LogoutButton } from "@/components/logout-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CreateKeyWizard,
  type CreateKeyPayload,
} from "@/components/employee/create-key-wizard";
import { KeyCard } from "@/components/employee/key-card";
import { CustomRoutesCard } from "@/components/employee/custom-routes-card";
import {
  ConfigDownloadDialog,
  type ConfigTarget,
} from "@/components/employee/config-download-dialog";
import {
  guideAudienceForDevice,
  InstallGuideDialog,
} from "@/components/employee/install-guide-dialog";
import { QuotaRequestDialog } from "@/components/employee/quota-request-dialog";
import { apiRequest } from "@/lib/api";
import { InlineTraffic } from "@/components/inline-traffic";
import { cn } from "@/lib/utils";
import { deviceTypeLabel } from "@/lib/device-type";
import { useT } from "@/lib/i18n/provider";
import type {
  KeyView,
  Me,
  NodeTraffic,
  NodeView,
  RouteProfileAvailability,
} from "@/lib/types";

export function EmployeeDashboard({
  canLogout = false,
}: {
  canLogout?: boolean;
}) {
  const { t } = useT();
  // `load` is memoized with empty deps; a ref keeps its error toast on the
  // current language without adding `t` to the dependency array.
  const tRef = React.useRef(t);
  React.useEffect(() => {
    tRef.current = t;
  }, [t]);
  const [me, setMe] = React.useState<Me | null>(null);
  const [nodes, setNodes] = React.useState<NodeView[]>([]);
  const [keys, setKeys] = React.useState<KeyView[]>([]);
  const [nodeTraffic, setNodeTraffic] = React.useState<NodeTraffic[]>([]);
  const [routeProfiles, setRouteProfiles] = React.useState<
    RouteProfileAvailability[]
  >([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [showCreate, setShowCreate] = React.useState(false);
  const [showQuota, setShowQuota] = React.useState(false);
  const [showGuide, setShowGuide] = React.useState(false);
  // The audience the guide opens on. A key card sets its own device; the
  // empty-state button leaves it null, so a user with no keys still chooses.
  const [guideAudience, setGuideAudience] =
    React.useState<GuideAudience | null>(null);
  const openGuide = React.useCallback((audience: GuideAudience | null) => {
    setGuideAudience(audience);
    setShowGuide(true);
  }, []);
  const [configTarget, setConfigTarget] = React.useState<ConfigTarget | null>(
    null,
  );
  const [justCreatedId, setJustCreatedId] = React.useState<string | null>(null);
  const scrolledForId = React.useRef<string | null>(null);

  const load = React.useCallback(async (silent = false) => {
    try {
      const [meResult, nodeResult, keyResult] = await Promise.all([
        apiRequest<Me>("/api/me"),
        apiRequest<NodeView[]>("/api/nodes"),
        apiRequest<KeyView[]>("/api/keys"),
      ]);
      setMe(meResult);
      setNodes(nodeResult);
      setKeys(keyResult);
      try {
        setRouteProfiles(
          await apiRequest<RouteProfileAvailability[]>("/api/route-profiles"),
        );
      } catch {
        setRouteProfiles([]);
      }
    } catch (cause) {
      // Background polls (silent) must not spam a toast every tick during a
      // transient outage — e.g. while the panel restarts after an update.
      if (!silent) {
        toast.error(
          cause instanceof Error
            ? cause.message
            : tRef.current("common.loadFailed"),
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // While any key is still provisioning, poll so its card flips to "active"
  // (and its spinner clears) without the user hitting Refresh.
  const anyProvisioning = React.useMemo(
    () => keys.some((key) => key.state === "provisioning"),
    [keys],
  );
  React.useEffect(() => {
    if (!anyProvisioning) return;
    const timer = setInterval(() => void load(true), 4000);
    return () => clearInterval(timer);
  }, [anyProvisioning, load]);

  // After creating a key, scroll to and focus its card once it appears — no
  // dialog, the card's own spinner shows progress while it provisions.
  React.useEffect(() => {
    if (!justCreatedId || scrolledForId.current === justCreatedId) return;
    const el = document.getElementById(`key-card-${justCreatedId}`);
    if (!el) return;
    scrolledForId.current = justCreatedId;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus({ preventScroll: true });
  }, [justCreatedId, keys]);

  // Per-server traffic (Today / 7 days / Month, all inline).
  const showTraffic = me?.policy.showTraffic ?? false;
  React.useEffect(() => {
    if (!showTraffic) return;
    let active = true;
    apiRequest<NodeTraffic[]>("/api/traffic/by-node")
      .then((data) => {
        if (active) setNodeTraffic(data);
      })
      .catch(() => {
        if (active) setNodeTraffic([]);
      });
    return () => {
      active = false;
    };
  }, [showTraffic]);

  const nodeById = React.useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );

  const existingNames = React.useMemo(
    () => keys.map((key) => key.deviceLabel ?? "").filter(Boolean),
    [keys],
  );

  // Revoked / admin-removed keys are not shown to the owner.
  const visibleKeys = React.useMemo(
    () => keys.filter((key) => !["revoked", "revoking"].includes(key.state)),
    [keys],
  );

  // The limit is per node: quota is shown and enforced per available node.
  const keyLimit = me?.keyLimit ?? 5;
  // A node may carry its own limit; nodes without one use the flat `keyLimit`.
  const quotaByNode = React.useMemo(
    () => new Map((me?.perNode ?? []).map((entry) => [entry.nodeId, entry])),
    [me],
  );
  const trafficByNode = React.useMemo(
    () => new Map(nodeTraffic.map((entry) => [entry.nodeId, entry])),
    [nodeTraffic],
  );
  const nodeQuota = React.useMemo(
    () =>
      nodes.map((node) => ({
        node,
        used: quotaByNode.get(node.id)?.used ?? 0,
        limit: quotaByNode.get(node.id)?.limit ?? keyLimit,
        traffic: trafficByNode.get(node.id),
      })),
    [nodes, quotaByNode, keyLimit, trafficByNode],
  );
  const atLimit =
    nodeQuota.length === 0 ||
    nodeQuota.every((entry) => entry.used >= entry.limit);
  const canCreate = Boolean(me?.policy.allowKeyCreation) && !atLimit;

  const createKey = async (payload: CreateKeyPayload) => {
    const created = await apiRequest<{ id: string }>("/api/keys", {
      method: "POST",
      body: JSON.stringify({
        nodeId: payload.nodeId,
        protocol: payload.protocol,
        deviceType: payload.deviceType,
        deviceLabel: payload.deviceLabel || undefined,
        routeProfile: payload.routeProfile,
        nameDisplay: payload.nameDisplay,
      }),
    });
    toast.success(t("emp.keyCreated"));
    if (created?.id) {
      // Don't pop the config dialog — the key is still provisioning and its
      // config isn't ready (that was the "load failed" error). Mark it so the
      // list scrolls to and focuses the new card, which shows a spinner until
      // provisioning finishes.
      scrolledForId.current = null;
      setJustCreatedId(created.id);
    }
    await load();
  };

  const rotate = async (keyId: string) => {
    if (!window.confirm(t("emp.rotateConfirm"))) return;
    setBusy(true);
    try {
      await apiRequest(`/api/keys/${keyId}/rotate`, { method: "POST" });
      toast.success(t("emp.rotateToast"));
      await load();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("emp.rotateFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (keyId: string) => {
    if (!window.confirm(t("emp.revokeConfirm"))) return;
    setBusy(true);
    try {
      await apiRequest(`/api/keys/${keyId}`, { method: "DELETE" });
      toast.success(t("emp.revoked"));
      await load();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("emp.revokeFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col">
      <AppHeader
        title={t("emp.title")}
        subtitle={me?.email ?? t("emp.loadingProfile")}
        actions={
          <>
            {me?.role === "admin" ? (
              <Button asChild variant="ghost" size="sm">
                <Link href="/admin" prefetch={false}>
                  <ShieldCheck className="h-4 w-4" /> {t("emp.admin")}
                </Link>
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={busy}
            >
              <RefreshCw className="h-4 w-4" /> {t("emp.refresh")}
            </Button>
            {canLogout ? <LogoutButton /> : null}
          </>
        }
      />

      <main className="flex flex-1 flex-col gap-5 p-4 sm:p-6">
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <KeyRound className="h-6 w-6" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">
                    {t("emp.quotaUsage")}
                  </p>
                  <p className="text-sm font-medium">
                    {t("emp.quotaPerNode", { limit: keyLimit })}
                  </p>
                </div>
              </div>
              <Button
                variant="link"
                size="sm"
                className="shrink-0 px-0"
                onClick={() => setShowQuota(true)}
              >
                {t("emp.requestMore")}
              </Button>
            </div>
            {nodeQuota.length > 0 ? (
              <div className="space-y-2.5 border-t pt-3">
                {nodeQuota.map(({ node, used, limit, traffic }) => (
                  <div
                    key={node.id}
                    className="flex flex-wrap items-start justify-between gap-2"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <span className="block truncate text-sm text-muted-foreground">
                        {node.name}
                      </span>
                      {showTraffic ? (
                        <InlineTraffic
                          today={traffic?.today}
                          week={traffic?.week}
                          month={traffic?.month}
                        />
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                      <span className="tabular-nums text-xs text-muted-foreground">
                        {used}/{limit}
                      </span>
                      <QuotaCells used={used} limit={limit} />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{t("emp.devices")}</h2>
          <Button disabled={!canCreate} onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" /> {t("emp.newKey")}
          </Button>
        </div>

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-44 rounded-xl" />
            ))}
          </div>
        ) : visibleKeys.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <KeyRound className="h-7 w-7" />
              </div>
              <h3 className="text-base font-semibold">{t("emp.noKeys")}</h3>
              <p className="max-w-sm text-sm text-muted-foreground">
                {t("emp.noKeysHint")}
              </p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                <Button
                  disabled={!canCreate}
                  onClick={() => setShowCreate(true)}
                >
                  <Plus className="h-4 w-4" /> {t("emp.createFirst")}
                </Button>
                <Button variant="outline" onClick={() => openGuide(null)}>
                  <CircleHelp className="h-4 w-4" /> {t("install.button")}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          // Independent columns (masonry): a tall card (rules-outdated callout)
          // no longer forces a gap under its shorter neighbour.
          <div className="columns-1 gap-3 sm:columns-2 [&>*]:mb-3">
            {visibleKeys.map((key) => (
              <div
                key={key.id}
                id={`key-card-${key.id}`}
                tabIndex={-1}
                className={cn(
                  "break-inside-avoid rounded-2xl outline-none transition-shadow",
                  key.id === justCreatedId &&
                    key.state === "provisioning" &&
                    "ring-2 ring-primary/40",
                )}
              >
                <KeyCard
                  keyView={key}
                  node={nodeById.get(key.nodeId)}
                  me={me!}
                  busy={busy}
                  onShowConfig={() =>
                    setConfigTarget({
                      id: key.id,
                      deviceLabel: key.deviceLabel || deviceTypeLabel(t, key.deviceType),
                      routeProfile: key.routeProfile,
                    })
                  }
                  onShowGuide={() =>
                    openGuide(guideAudienceForDevice(key.deviceType))
                  }
                  onRotate={() => void rotate(key.id)}
                  onRevoke={() => void revoke(key.id)}
                />
              </div>
            ))}
          </div>
        )}

        {me?.policy.allowCustomRoutes ? (
          <>
            <h2 className="text-base font-semibold">
              {t("routes.sectionTitle")}
            </h2>
            <CustomRoutesCard me={me} onSaved={load} />
          </>
        ) : null}
      </main>

      {me ? (
        <>
          <CreateKeyWizard
            open={showCreate}
            onOpenChange={setShowCreate}
            me={me}
            nodes={nodes}
            routeProfiles={routeProfiles}
            existingNames={existingNames}
            onCreate={createKey}
          />
          <QuotaRequestDialog
            open={showQuota}
            onOpenChange={setShowQuota}
            me={me}
            nodeQuota={nodeQuota}
            onSubmitted={load}
          />
        </>
      ) : null}
      <ConfigDownloadDialog
        target={configTarget}
        onClose={() => setConfigTarget(null)}
        me={me}
      />
      <InstallGuideDialog
        open={showGuide}
        onOpenChange={setShowGuide}
        // Both flags, matching assertDownloadAllowed in the control API: a
        // .conf is only downloadable when redownload AND .conf are permitted.
        showConfSection={Boolean(
          me?.policy.allowConfigRedownload && me?.policy.allowConfDownload,
        )}
        // Walkthrough videos are a policy value, so an admin can attach one
        // without a deploy. Absent until then — the guide shows a placeholder.
        videos={me?.policy.installGuideVideos ?? null}
        initialAudience={guideAudience}
      />
    </div>
  );
}

/**
 * Quota shown as one cell per key slot: filled (green) = issued, empty (grey) =
 * free. One cell per key so "3 of 5 used" reads at a glance.
 */
function QuotaCells({ used, limit }: { used: number; limit: number }) {
  const { t } = useT();
  const total = Math.max(limit, used, 1);
  const shown = Math.min(total, 40);
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      aria-label={t("quota.cellsAria", { used, limit })}
    >
      {Array.from({ length: shown }, (_, index) => (
        <span
          key={index}
          title={index < used ? t("quota.cellIssued") : t("quota.cellFree")}
          className={cn(
            "size-4 rounded-[5px] transition-colors",
            index < used
              ? "bg-success"
              : "bg-muted ring-1 ring-inset ring-border",
          )}
        />
      ))}
      {total > shown ? (
        <span className="ml-1 text-xs text-muted-foreground">
          +{total - shown}
        </span>
      ) : null}
    </div>
  );
}

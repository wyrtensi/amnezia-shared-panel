"use client";

import * as React from "react";
import Link from "next/link";
import {
  ChevronDown,
  CircleHelp,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { GuideAudience } from "@amnezia/contracts";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { LogoutButton } from "@/components/logout-button";
import type { LogoutMode } from "@/lib/logout";
import { Badge } from "@/components/ui/badge";
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
import { InstallReminderDialog } from "@/components/employee/install-reminder-dialog";
import { KeyHelpDialog } from "@/components/employee/key-help-dialog";
import { QuotaRequestDialog } from "@/components/employee/quota-request-dialog";
import { apiRequest } from "@/lib/api";
import { helpLinkSearch, readHelpLink, type HelpLink } from "@/lib/help-links";
import {
  keyNumberOf,
  shouldShowInstallReminder,
} from "@/lib/install-reminder";
import { isAtLimit } from "@/lib/key-quota";
import { isVisibleToOwner } from "@/lib/key-states";
import { InlineTraffic } from "@/components/inline-traffic";
import { ServiceCheckChips } from "@/components/service-check-chips";
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
  logoutMode = null,
}: {
  logoutMode?: LogoutMode | null;
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
  const [showKeyHelp, setShowKeyHelp] = React.useState(false);
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
  const [showInstallReminder, setShowInstallReminder] = React.useState(false);
  const remindedForId = React.useRef<string | null>(null);

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

  /**
   * Open what the link asked for — `?help=install&os=android`, `?help=key`.
   *
   * Gated on `me` rather than on mount: the dialogs sit inside a page that is
   * still deciding who the visitor is, and a guide flashing open over an
   * unauthenticated frame is worse than a guide half a second late. It runs
   * once, so it cannot re-open a dialog the user has since closed (the sync
   * below clears the parameter anyway, but a background reload of `me` must not
   * depend on that).
   *
   * A dialog the visitor cannot use would be skipped here, exactly as if the
   * parameter were absent. Neither of these two is gated today — both buttons
   * are on every user's dashboard, the key-help one deliberately so even at the
   * quota — which is why the check reads as a plain `true` per dialog rather
   * than as a policy lookup that would go stale beside the buttons.
   */
  const [linkRead, setLinkRead] = React.useState(false);
  React.useEffect(() => {
    if (!me || linkRead) return;
    setLinkRead(true);
    const link = readHelpLink(window.location.search);
    if (!link) return;
    if (link.dialog === "install") openGuide(link.audience);
    else setShowKeyHelp(true);
  }, [me, linkRead, openGuide]);

  /**
   * ...and keep the address bar on it, which is the half that makes the links
   * obtainable: an operator gets one by opening the dialog and copying the bar,
   * not by reading the source.
   *
   * `replaceState`, never a push: closing a dialog must not send the user back
   * through every device group they clicked. Waits for the read above so it
   * cannot wipe the incoming link before anything has looked at it.
   */
  React.useEffect(() => {
    if (!linkRead) return;
    const link: HelpLink | null = showGuide
      ? { dialog: "install", audience: guideAudience }
      : showKeyHelp
        ? { dialog: "key", audience: null }
        : null;
    const search = helpLinkSearch(window.location.search, link);
    if (search === window.location.search) return;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${search}${window.location.hash}`,
    );
  }, [linkRead, showGuide, showKeyHelp, guideAudience]);

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

  /**
   * ...and, for a regular user's first few keys, stop them here first: the key
   * is useless until the AmneziaVPN client is new enough to read it.
   *
   * Keyed on the key APPEARING IN THE LIST, not on the create button: a failed
   * creation has nothing to install for, and the list is also where the
   * authoritative `keyNumber` comes from. Waits for the wizard to close so two
   * dialogs never overlap, and runs once per created key — `remindedForId` is
   * what stops a background poll re-opening a dialog the user has dismissed.
   */
  React.useEffect(() => {
    if (!justCreatedId || showCreate) return;
    if (remindedForId.current === justCreatedId) return;
    const created = keys.find((key) => key.id === justCreatedId);
    if (!created) return;
    remindedForId.current = justCreatedId;
    if (shouldShowInstallReminder({ me, keyNumber: keyNumberOf(created) })) {
      // The "key created" toast is top-centre and lands squarely over this
      // dialog's title for the few seconds that matter most. The dialog opens
      // by saying the key is ready, so the toast has nothing left to add.
      toast.dismiss();
      setShowInstallReminder(true);
    }
  }, [justCreatedId, showCreate, keys, me]);

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

  // Which states an owner sees is one decision, made in `lib/key-states.ts`
  // and written down in `docs/KEY-STATES.md`. Inlining the list here is how it
  // drifted from the state model in the first place.
  const visibleKeys = React.useMemo(
    () => keys.filter((key) => isVisibleToOwner(key.state)),
    [keys],
  );

  // Per-node or one shared pool, as the API enforces it (absent = per-node).
  const keyLimitMode = me?.keyLimitMode ?? "per_node";
  const keyLimit = me?.keyLimit ?? 5;
  const keyCount = me?.keyCount ?? 0;
  const totals = { used: keyCount, limit: keyLimit };
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
  const atLimit = isAtLimit(
    keyLimitMode,
    nodeQuota.map(({ node, used, limit }) => ({ nodeId: node.id, used, limit })),
    totals,
  );
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
      remindedForId.current = null;
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

  /**
   * Write the operator-only note on one of MY OWN keys, from the ordinary
   * panel.
   *
   * It posts to the admin endpoint because that is the only writer there has
   * ever been, and the endpoint is role-gated at the edge (`adminFor`): a
   * regular user reaching it gets 403 whatever the browser sends. Nothing new
   * is granted here — an administrator editing a note is an existing
   * capability in a second place, and the trigger that calls this only exists
   * on an administrator's card in the first place.
   *
   * Returns the boolean the dialog waits on, so a failed save keeps the draft
   * on screen instead of closing over a note that was never stored.
   */
  const setInternalName = async (
    keyId: string,
    internalName: string,
  ): Promise<boolean> => {
    try {
      await apiRequest(`/api/admin/keys/${keyId}/set-internal-name`, {
        method: "POST",
        body: JSON.stringify({ internalName }),
      });
      await load(true);
      return true;
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("users.internalNameFailed"),
      );
      return false;
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
            {logoutMode ? <LogoutButton mode={logoutMode} /> : null}
          </>
        }
      />

      <main className="flex flex-1 flex-col gap-5 p-4 sm:p-6">
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <KeyRound className="h-6 w-6" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">
                    {t("emp.quotaUsage")}
                  </p>
                  <p className="text-sm font-medium">
                    {keyLimitMode === "global"
                      ? t("emp.quotaTotal", { limit: keyLimit })
                      : t("emp.quotaPerNode", { limit: keyLimit })}
                  </p>
                </div>
              </div>
              {keyLimitMode === "global" ? (
                // Global mode only: the pool as one grid, sized to the total.
                <div className="flex items-center gap-2.5">
                  <span className="tabular-nums text-xs text-muted-foreground">
                    {keyCount}/{keyLimit}
                  </span>
                  <QuotaCells used={keyCount} limit={keyLimit} />
                </div>
              ) : null}
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
              // The same rule that separates this block from the header now
              // also separates the servers from each other: with three or four
              // of them and a traffic line each, a plain gap left it unclear
              // which numbers belonged to which name.
              <div className="divide-y border-t">
                {nodeQuota.map(({ node, used, limit, traffic }) => (
                  <div
                    key={node.id}
                    // The same accent the create-key wizard puts on a
                    // recommended server, carried onto the page the user
                    // actually lands on. The badge stays — colour alone is not
                    // an accessible signal — and `border-primary` resolves per
                    // theme so the edge does not vanish in dark mode. The
                    // transparent border on the other rows keeps every server
                    // name on the same baseline. Only the LEFT colour is set:
                    // the parent's `divide-y` draws its separators as a top
                    // border on these same rows, and a blanket `border-*`
                    // would repaint those too.
                    className={cn(
                      "flex flex-wrap items-start justify-between gap-2 border-l-2 py-2.5 pl-2.5 first:pt-3",
                      node.recommended
                        // Green, to match the "Recommended" badge beside it, and
                        // an edge only: a tinted row reads as selected or as
                        // disabled depending on who is looking, and in a list of
                        // servers it drew a horizontal band across the card that
                        // competed with the row's own content.
                        ? "border-l-success"
                        : "border-l-transparent",
                    )}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm text-muted-foreground">
                          {node.name}
                        </span>
                        {node.recommended ? (
                          <Badge variant="success" className="shrink-0">
                            {t("wizard.recommended")}
                          </Badge>
                        ) : null}
                      </span>
                      {/* Conditional on the field, not on a policy flag: the
                          control API omits it when the policy says no, so the
                          dashboard holds no rule of its own. */}
                      {node.publicAddress ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          <span className="sr-only">
                            {t("emp.nodeAddress")}:{" "}
                          </span>
                          <code className="tabular">{node.publicAddress}</code>
                        </span>
                      ) : null}
                      {showTraffic ? (
                        <InlineTraffic
                          today={traffic?.today}
                          week={traffic?.week}
                          month={traffic?.month}
                        />
                      ) : null}
                      {/* Present only when the policy allows it - the API omits
                          the key entirely otherwise, so the dashboard holds no
                          rule of its own. */}
                      <ServiceCheckChips checks={node.status?.checks} />
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                      <span className="tabular-nums text-xs text-muted-foreground">
                        {keyLimitMode === "global" ? used : `${used}/${limit}`}
                      </span>
                      {keyLimitMode === "global" ? (
                        // The free slots belong to the pool, not to this server.
                        <QuotaCells used={used} limit={used} issuedOnly />
                      ) : (
                        <QuotaCells used={used} limit={limit} />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <h2 className="text-base font-semibold">{t("emp.devices")}</h2>
            {/* Spelled out, beside the section heading: this is the one action a
                user who cannot connect is looking for, and the icon on each card
                did not read as a button. The card's icon stays because it knows
                that key's device and opens straight to its instruction; this one
                asks first, because from here no device is implied. */}
            {/* Drawn as a link, not as a ghost button: a user who cannot
                connect scans for something clickable, and an unstyled label
                beside a heading did not read as one. `text-success` is the
                theme's own token, so the colour holds in light and dark
                without a second rule. */}
            <Button
              variant="ghost"
              size="sm"
              className="px-2 text-success underline decoration-2 underline-offset-4 hover:text-success"
              onClick={() => openGuide(null)}
            >
              <CircleHelp className="h-4 w-4" /> {t("install.button")}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* To the LEFT of "New key" and the same size: the user who needs
                it is looking at that button and not pressing it. It opens the
                form's own explanation, never the install guide — see
                KeyHelpDialog. Not disabled with the quota: someone at their
                limit may still be trying to understand the form. */}
            <Button variant="secondary" onClick={() => setShowKeyHelp(true)}>
              <CircleHelp className="h-4 w-4" /> {t("keyHelp.button")}
            </Button>
            <Button disabled={!canCreate} onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" /> {t("emp.newKey")}
            </Button>
          </div>
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
          // Plain grid, not multi-column: multi-column fills column-major
          // (1,3,5 / 2,4,6 reading order), which is wrong for a list people
          // scan top to bottom. Grid fills row-major (1,2 / 3,4 / 5,6) at the
          // cost of the masonry packing multi-column gave us: a row's height
          // is set by its tallest card, so when a tall card (rules-outdated
          // callout) shares a row with a shorter one, the shorter card
          // leaves a gap below it instead of the next card flowing up into it.
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {visibleKeys.map((key) => (
              <div
                key={key.id}
                id={`key-card-${key.id}`}
                tabIndex={-1}
                className={cn(
                  "rounded-2xl outline-none transition-shadow",
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
                  onSetInternalName={(internalName) =>
                    setInternalName(key.id, internalName)
                  }
                />
              </div>
            ))}
          </div>
        )}

        {/*
          Collapsed, because it puzzles the people who do not need it: a list of
          addresses to add by hand, sitting under the keys, reads as something
          that has to be filled in. It matters only to somebody on a split
          profile who has found a site the built-in list misses. Full width
          either way, so opening it does not move the page around.
        */}
        {me?.policy.allowCustomRoutes ? (
          <details className="group w-full">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-base font-semibold">
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
              {t("routes.sectionTitle")}
            </summary>
            <div className="mt-3">
              <CustomRoutesCard me={me} onSaved={load} />
            </div>
          </details>
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
            keyLimitMode={keyLimitMode}
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
      <InstallReminderDialog
        open={showInstallReminder}
        onOpenChange={setShowInstallReminder}
        // Straight into the guide the rest of the panel already uses, on its
        // device chooser. Not pre-selected from the key's device type: the
        // wizard preselects the first device card, so that value is often a
        // default the user never looked at, and this is the one dialog whose
        // whole job is to stop somebody acting on a wrong assumption. The
        // chooser is one click and always right.
        onContinue={() => {
          setShowInstallReminder(false);
          openGuide(null);
        }}
      />
      <KeyHelpDialog
        open={showKeyHelp}
        onOpenChange={setShowKeyHelp}
        // Making the key is half the job; the other half is behind the connect
        // guide, and someone who needed this dialog will need that one next.
        // Hands over rather than stacking: this closes as that opens.
        onOpenGuide={() => {
          setShowKeyHelp(false);
          // Through `openGuide`, so the guide opens on its chooser: from here no
          // device is implied, and the audience a key card left behind would
          // otherwise answer a question this user was never asked.
          openGuide(null);
        }}
      />
      <InstallGuideDialog
        open={showGuide}
        onOpenChange={setShowGuide}
        // The file the guide teaches is .vpn, which carries no flag of its own
        // — it is the payload the copy button already hands out — so the
        // section follows the one policy that decides whether a key card shows
        // any download at all.
        showFileSection={Boolean(me?.policy.allowConfigRedownload)}
        // The .conf fallback keeps both flags, matching assertDownloadAllowed
        // in the control API: a .conf is only downloadable when redownload AND
        // .conf are permitted.
        showConfFallback={Boolean(
          me?.policy.allowConfigRedownload && me?.policy.allowConfDownload,
        )}
        allowCustomRoutes={Boolean(me?.policy.allowCustomRoutes)}
        // Walkthrough videos are a policy value, so an admin can attach one
        // without a deploy. Absent until then — the guide shows a placeholder.
        videos={me?.policy.installGuideVideos ?? null}
        initialAudience={guideAudience}
        // Mirrors the reader's pick so the address bar can carry `os=`. Safe to
        // feed back through `initialAudience`: the dialog resets only on the
        // opening transition.
        onAudienceChange={setGuideAudience}
      />
    </div>
  );
}

/**
 * Quota shown as one cell per key slot: filled (green) = issued, empty (grey) =
 * free. One cell per key so "3 of 5 used" reads at a glance. With `issuedOnly`
 * (global-mode server rows) only the green cells are drawn: the free slots
 * belong to the pool, not to any one server.
 */
function QuotaCells({
  used,
  limit,
  issuedOnly = false,
}: {
  used: number;
  limit: number;
  issuedOnly?: boolean;
}) {
  const { t } = useT();
  const total = issuedOnly ? used : Math.max(limit, used, 1);
  const shown = Math.min(total, 40);
  if (issuedOnly && used === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {t("quota.noKeysOnServer")}
      </span>
    );
  }
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      aria-label={
        issuedOnly
          ? t("quota.cellsIssuedAria", { used })
          : t("quota.cellsAria", { used, limit })
      }
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

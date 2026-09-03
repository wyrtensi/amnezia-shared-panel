"use client";

import * as React from "react";
import {
  ChevronDown,
  Download,
  ExternalLink,
  FileDown,
  RefreshCw,
  TabletSmartphone,
  TriangleAlert,
} from "lucide-react";
import {
  MIN_AWG3_CLIENT_VERSION,
  type ClientAsset,
  type ClientPlatform,
  type ClientPlatformDownload,
  type ClientRelease,
} from "@amnezia/contracts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/hint";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/api";
import { formatBytesParts } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { DEVICE_ICON } from "@/components/device-icon";
import type { PlatformMark } from "@/components/icons/platform-marks";
import type { Lang } from "@/lib/i18n/messages";

// The guide reuses the wizard's vendored brand marks rather than keeping its
// own glyphs: ClientPlatform is a strict subset of DeviceType, so the same map
// serves both, and a user meets the same mark on the card they picked and on
// the download button they press. A second map here would be one more place to
// drift.
const PLATFORM_ICON: Record<ClientPlatform, PlatformMark> = {
  windows: DEVICE_ICON.windows,
  macos: DEVICE_ICON.macos,
  linux: DEVICE_ICON.linux,
  android: DEVICE_ICON.android,
  ios: DEVICE_ICON.ios,
};

// Ordered walkthroughs. Numbering is rendered by <ol>, never translated.
const ADD_STEPS = [
  "install.addStep1",
  "install.addStep2",
  "install.addStep3",
  "install.addStep4",
] as const;

const APK_STEPS = [
  "install.apkStep1",
  "install.apkStep2",
  "install.apkStep3",
  "install.apkStep4",
] as const;

const CONF_AMNEZIA_STEPS = [
  "install.confAmneziaStep1",
  "install.confAmneziaStep2",
  "install.confAmneziaStep3",
] as const;

const FIXES = [
  "install.fixServer",
  "install.fixFullTunnel",
  "install.fixUpdate",
] as const;

/** Rounded download size, or null when the asset is a store or a page link. */
const assetSize = (asset: ClientAsset, lang: Lang): string | null => {
  if (asset.sizeBytes === null) return null;
  const parts = formatBytesParts(String(asset.sizeBytes), lang);
  return parts ? `${parts.value} ${parts.unit}` : null;
};

/**
 * How to install AmneziaVPN and connect: get the client, add a pasted key, use
 * a .conf file, and what to try when nothing connects.
 *
 * Every download link comes from GET /api/client-releases — control-api
 * resolves the newest release and caches it, because a user may be on a network
 * with no route to GitHub and because apps/web holds no business logic. The
 * request is made on first open, not on page load.
 */
export function InstallGuideDialog({
  open,
  onOpenChange,
  showConfSection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showConfSection: boolean;
}) {
  const { t } = useT();
  const [release, setRelease] = React.useState<ClientRelease | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!open || release || failed) return;
    let active = true;
    apiRequest<ClientRelease>("/api/client-releases")
      .then((data) => {
        if (active) setRelease(data);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [open, release, failed]);

  // The three groups the guide is organised into. Built by filtering the flat
  // per-platform list the API returns, so a platform added to the contract
  // shows up here rather than silently disappearing from the dialog.
  const byPlatform = (...wanted: ClientPlatform[]) =>
    (release?.downloads ?? []).filter((entry) =>
      wanted.includes(entry.platform),
    );
  const desktop = byPlatform("windows", "macos", "linux");
  const androidGroup = byPlatform("android");
  const ios = byPlatform("ios");
  const android = androidGroup[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("install.title")}</DialogTitle>
          <DialogDescription>{t("install.desc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <GuideSection number={1} title={t("install.installTitle")}>
            {failed ? (
              <Callout tone="warning" icon={<TriangleAlert className="h-4 w-4" />}>
                {t("install.linksUnavailable")}
              </Callout>
            ) : !release ? (
              <div className="space-y-2">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} className="h-16 rounded-md" />
                ))}
              </div>
            ) : (
              <>
                {release.fallback ? (
                  <Callout
                    tone="warning"
                    icon={<TriangleAlert className="h-4 w-4" />}
                  >
                    {t("install.linksStale")}
                  </Callout>
                ) : null}
                {/* Three groups, not five buttons: the steps that follow differ
                    by group, not by vendor. Windows, macOS and Linux are one
                    desktop story (download an installer, run it); Android has a
                    store plus an APK escape hatch; iOS has a differently-named
                    store listing and the route-profile limitation. Each group
                    carries its own notes so a user reads one block, not all. */}
                <div className="space-y-4">
                  <PlatformGroup
                    title={t("install.group.desktop")}
                    downloads={desktop}
                  >
                    <p className="text-xs leading-snug text-muted-foreground">
                      {t("install.desktopNote")}
                    </p>
                  </PlatformGroup>

                  <PlatformGroup
                    title={t("install.group.android")}
                    downloads={androidGroup}
                  >
                    {android?.alternate ? (
                      <ApkFallback
                        asset={android.alternate}
                        releaseUrl={release.releaseUrl}
                      />
                    ) : null}
                  </PlatformGroup>

                  <PlatformGroup title={t("install.group.ios")} downloads={ios}>
                    <Callout
                      tone="info"
                      icon={<TabletSmartphone className="h-4 w-4" />}
                    >
                      {t("install.iosNote")}
                    </Callout>
                    {/*
                      iOS connects with a route profile but applies none of its
                      rules — a silent failure the user cannot see. Stated here,
                      inside the iOS block, so it reaches iPhone users whose
                      policy hides the .conf section below. See D8.
                    */}
                    <Callout
                      tone="warning"
                      icon={<TriangleAlert className="h-4 w-4" />}
                    >
                      {t("install.iosProfileWarning")}
                    </Callout>
                  </PlatformGroup>
                </div>
                {release.version ? (
                  <p className="text-xs leading-snug text-muted-foreground">
                    {t("install.latestVersion", { version: release.version })}
                  </p>
                ) : null}
              </>
            )}

            <p className="text-xs leading-snug text-muted-foreground">
              {t("install.versionNote", { version: MIN_AWG3_CLIENT_VERSION })}
            </p>
          </GuideSection>

          <GuideSection number={2} title={t("install.addTitle")}>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm">
              {ADD_STEPS.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ol>
            <p className="text-xs leading-snug text-muted-foreground">
              {t("install.addResult")}
            </p>
          </GuideSection>

          {showConfSection ? (
            <GuideSection number={3} title={t("install.confTitle")}>
              <p className="text-sm">{t("install.confBody")}</p>
              <p className="text-sm">{t("install.confSplitBest")}</p>
              {/*
                confSplitBest recommends a split-profile .conf; on iOS that
                config connects and filters nothing. The exception must stay
                directly under the recommendation — install-guide-dialog.test.ts
                asserts the adjacency so an edit cannot separate them. See D8.
              */}
              <Callout tone="warning" icon={<TriangleAlert className="h-4 w-4" />}>
                {t("install.confIosWarning")}
              </Callout>

              <h4 className="text-sm font-medium">
                {t("install.confAmneziaTitle")}
              </h4>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                {CONF_AMNEZIA_STEPS.map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ol>

              <h4 className="text-sm font-medium">
                {t("install.confOtherTitle")}
              </h4>
              <p className="text-sm">{t("install.confOtherBody")}</p>
              <Callout tone="warning" icon={<TriangleAlert className="h-4 w-4" />}>
                {t("install.confStockWarning")}
              </Callout>
              <Callout tone="info" icon={<FileDown className="h-4 w-4" />}>
                {t("install.confDomainsWarning")}
              </Callout>
            </GuideSection>
          ) : null}

          <GuideSection
            number={showConfSection ? 4 : 3}
            title={t("install.fixTitle")}
          >
            <ul className="list-disc space-y-1.5 pl-5 text-sm">
              {FIXES.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
            {release ? (
              <Button asChild variant="secondary" size="sm" className="w-fit">
                <a
                  href={release.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={t("install.opensNewTab")}
                >
                  <RefreshCw className="h-4 w-4" /> {t("install.checkUpdates")}
                </a>
              </Button>
            ) : null}
          </GuideSection>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One platform button: icon, platform name, and what the link actually is. */
function PlatformButton({ download }: { download: ClientPlatformDownload }) {
  const { t, lang } = useT();
  const Icon = PLATFORM_ICON[download.platform];
  const asset = download.primary;
  const size = assetSize(asset, lang);

  return (
    <Button asChild variant="outline" className="h-auto justify-start py-2">
      <a
        href={asset.url}
        target="_blank"
        rel="noreferrer"
        title={t("install.opensNewTab")}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate">
            {t(`install.platform.${download.platform}`)}
          </span>
          {asset.kind === "installer" && size ? (
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {size}
            </span>
          ) : asset.kind === "releasePage" ? (
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {t("install.pickFile")}
            </span>
          ) : null}
        </span>
        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </a>
    </Button>
  );
}

/**
 * One audience's block: a heading, its download buttons, and the notes that
 * apply only to it. Grouping is what makes the guide readable — a user on an
 * iPhone should not have to filter Windows advice out of a flat list.
 */
function PlatformGroup({
  title,
  downloads,
  children,
}: {
  title: string;
  downloads: ClientPlatformDownload[];
  children?: React.ReactNode;
}) {
  if (downloads.length === 0) return null;
  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-3">
      <p className="text-sm font-medium">{title}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {downloads.map((entry) => (
          <PlatformButton key={entry.platform} download={entry} />
        ))}
      </div>
      {children}
    </div>
  );
}

/**
 * "Google Play does not work" — the APK route, collapsed by default so the
 * common case stays one button. A native <details> keeps it keyboard-accessible
 * without another Radix primitive.
 */
function ApkFallback({
  asset,
  releaseUrl,
}: {
  asset: ClientAsset;
  releaseUrl: string | null;
}) {
  const { t, lang } = useT();
  const size = assetSize(asset, lang);

  return (
    <details className="group rounded-lg border bg-muted/30 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
        <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
        {t("install.apkTitle")}
      </summary>
      <div className="mt-2.5 space-y-2.5">
        <p className="text-xs leading-snug text-muted-foreground">
          {t("install.apkIntro")}
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm">
          {APK_STEPS.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ol>
        <Button asChild variant="secondary" size="sm" className="w-fit">
          <a
            href={asset.url}
            target="_blank"
            rel="noreferrer"
            title={t("install.opensNewTab")}
          >
            <Download className="h-4 w-4" /> {t("install.apkDownload")}
            {size ? (
              <span className="text-xs text-muted-foreground">{size}</span>
            ) : null}
          </a>
        </Button>
        {releaseUrl ? (
          <p className="text-xs leading-snug text-muted-foreground">
            <a
              className="underline underline-offset-2"
              href={releaseUrl}
              target="_blank"
              rel="noreferrer"
              title={t("install.opensNewTab")}
            >
              {t("install.apkOtherBuilds")}
            </a>
          </p>
        ) : null}
      </div>
    </details>
  );
}

/** Numbered section: a small circled index, a heading, then free content. */
function GuideSection({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs text-primary"
        >
          {number}
        </span>
        {title}
      </h3>
      <div className="space-y-2.5 pl-8">{children}</div>
    </section>
  );
}

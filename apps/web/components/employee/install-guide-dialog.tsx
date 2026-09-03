"use client";

import * as React from "react";
import {
  ChevronDown,
  Download,
  ExternalLink,
  FileDown,
  Laptop,
  Monitor,
  RefreshCw,
  Smartphone,
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
import type { Lang } from "@/lib/i18n/messages";

const PLATFORM_ICON: Record<
  ClientPlatform,
  React.ComponentType<{ className?: string }>
> = {
  windows: Monitor,
  macos: Laptop,
  android: Smartphone,
  ios: TabletSmartphone,
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

  const android = release?.downloads.find(
    (entry) => entry.platform === "android",
  );

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
              <div className="grid grid-cols-2 gap-2">
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} className="h-11 rounded-md" />
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
                <div className="grid grid-cols-2 gap-2">
                  {release.downloads.map((entry) => (
                    <PlatformButton key={entry.platform} download={entry} />
                  ))}
                </div>
                {release.version ? (
                  <p className="text-xs leading-snug text-muted-foreground">
                    {t("install.latestVersion", { version: release.version })}
                  </p>
                ) : null}
              </>
            )}

            <p className="text-xs leading-snug text-muted-foreground">
              {t("install.desktopNote")}
            </p>
            <Callout tone="info" icon={<TabletSmartphone className="h-4 w-4" />}>
              {t("install.iosNote")}
            </Callout>
            {/*
              iOS connects with a route profile but applies none of its rules —
              a silent failure the user cannot see. Stated here, in the always-
              visible install section, so it reaches iPhone users whose policy
              hides the .conf section below. See D8.
            */}
            <Callout tone="warning" icon={<TriangleAlert className="h-4 w-4" />}>
              {t("install.iosProfileWarning")}
            </Callout>
            <p className="text-xs leading-snug text-muted-foreground">
              {t("install.versionNote", { version: MIN_AWG3_CLIENT_VERSION })}
            </p>

            {android?.alternate ? (
              <ApkFallback
                asset={android.alternate}
                releaseUrl={release?.releaseUrl ?? null}
              />
            ) : null}
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

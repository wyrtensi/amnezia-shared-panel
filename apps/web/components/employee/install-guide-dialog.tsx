"use client";

import * as React from "react";
import {
  ChevronDown,
  Download,
  ExternalLink,
  FileDown,
  RefreshCw,
  TabletSmartphone,
  QrCode,
  TriangleAlert,
  Video,
} from "lucide-react";
import {
  GUIDE_AUDIENCES,
  installVideoEmbed,
  MIN_AWG3_CLIENT_VERSION,
  type ClientAsset,
  type ClientPlatform,
  type ClientPlatformDownload,
  type ClientRelease,
  type GuideAudience,
  type InstallGuideVideos,
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
import { cn } from "@/lib/utils";
import { DEVICE_ICON } from "@/components/device-icon";
import { OptionCards } from "@/components/option-cards";
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

/**
 * Which platforms each audience's instruction covers. The audience list itself
 * is in the contract — the portal policy carries a video per audience — and
 * this map is the UI half: which download buttons that audience sees.
 */
export const AUDIENCE_PLATFORMS: Record<GuideAudience, readonly ClientPlatform[]> = {
  desktop: ["windows", "macos", "linux"],
  android: ["android"],
  ios: ["ios"],
};

/**
 * The guide audience that covers a device type, or null when the device names
 * no platform ("other", "unspecified") and the user must still choose. Takes a
 * plain string for the same reason as deviceTypeLabel: a tab left open across a
 * deploy receives whatever the new API sends, and an unknown value must fall
 * back to the chooser rather than to a wrong instruction.
 *
 * Derived from AUDIENCE_PLATFORMS rather than written out a second time:
 * ClientPlatform is a subset of DeviceType, and a hand-written copy would drift
 * the moment a platform moves between audiences.
 */
export function guideAudienceForDevice(device: string): GuideAudience | null {
  return (
    GUIDE_AUDIENCES.find((audience) =>
      (AUDIENCE_PLATFORMS[audience] as readonly string[]).includes(device),
    ) ?? null
  );
}

/** The mark shown on each chooser card; the desktop card leads with Windows. */
const AUDIENCE_ICON: Record<GuideAudience, PlatformMark> = {
  desktop: DEVICE_ICON.windows,
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
  // Ahead of "update the app", because it is the one that looks like a fix and
  // is not: a user hunting for a setting to change finds this switch first.
  "install.fixAmneziaDns",
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
  videos,
  initialAudience = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showConfSection: boolean;
  videos?: InstallGuideVideos | null;
  /**
   * Audience to open on, skipping the chooser. A key card knows the device the
   * key was labelled for, so it opens the one instruction that applies; the
   * chooser stays visible above so a wrong guess is one click to correct.
   */
  initialAudience?: GuideAudience | null;
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

  const [audience, setAudience] = React.useState<GuideAudience | null>(
    initialAudience,
  );

  // Each opening starts from the caller's audience: the header opens the
  // chooser, a key card opens its own device. Without this the dialog would
  // keep whatever the previous opening left behind.
  const wasOpen = React.useRef(open);
  React.useEffect(() => {
    if (open && !wasOpen.current) setAudience(initialAudience);
    wasOpen.current = open;
  }, [open, initialAudience]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("install.title")}</DialogTitle>
          <DialogDescription>{t("install.desc")}</DialogDescription>
        </DialogHeader>

        {/* Pick the device first, read one instruction after. */}
        <OptionCards
          ariaLabel={t("install.chooseTitle")}
          columns={3}
          value={audience}
          onChange={setAudience}
          options={GUIDE_AUDIENCES.map((value) => {
            const Icon = AUDIENCE_ICON[value];
            return {
              value,
              label: t(`install.group.${value}`),
              icon: <Icon />,
            };
          })}
        />

        {audience ? (
          <InstallInstructions
            audience={audience}
            release={release}
            failed={failed}
            showConfSection={showConfSection}
            videos={videos}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("install.chooseHint")}
          </p>
        )}

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
    // w-full because `asChild` hands the classes to an <a>, which is
    // inline-flex and would otherwise keep its intrinsic width and overlap
    // the QR button beside it.
    <Button
      asChild
      variant="outline"
      className="h-auto w-full justify-start py-2"
    >
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
 * The guide itself, for ONE audience. Exported separately from the dialog so
 * the same instruction can later be embedded elsewhere — the create-key wizard
 * or a key card — without copying it.
 */
export function InstallInstructions({
  audience,
  release,
  failed,
  showConfSection,
  videos,
}: {
  audience: GuideAudience;
  release: ClientRelease | null;
  failed: boolean;
  showConfSection: boolean;
  /** Per-audience walkthrough videos from the portal policy; empty by default. */
  videos?: InstallGuideVideos | null;
}) {
  const { t } = useT();
  const downloads = (release?.downloads ?? []).filter((entry) =>
    AUDIENCE_PLATFORMS[audience].includes(entry.platform),
  );
  const android = downloads.find((entry) => entry.platform === "android");
  const ios = downloads.find((entry) => entry.platform === "ios");
  // The .conf route is a real improvement on a computer and on Android. On iOS
  // it changes nothing — the rules are ignored either way — so that audience
  // gets the reason instead of instructions it cannot use. See D8.
  const confApplies = showConfSection && audience !== "ios";
  const videoUrl = videos?.[audience] ?? null;
  const [qrFor, setQrFor] = React.useState<ClientPlatform | null>(null);
  const fixNumber = confApplies ? 4 : 3;

  return (
    <div className="space-y-6">
          <GuideVideo url={videoUrl} />

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
                {/* One audience's buttons and only its notes. */}
                {/* Two columns only when there is a pair to pair up. The
                    store audiences have a single download, and halving that row
                    left no room for its label beside the QR button. */}
                <div
                  className={cn(
                    "grid gap-2",
                    downloads.length > 1 && "sm:grid-cols-2",
                  )}
                >
                  {downloads.map((entry) => (
                    <div key={entry.platform} className="space-y-2">
                      <div className="flex gap-2">
                        <div className="min-w-0 flex-1">
                          <PlatformButton download={entry} />
                        </div>
                        {/* Only a store link is worth scanning: a desktop
                            installer is downloaded on the machine already in
                            front of the reader. */}
                        {entry.primary.kind === "store" ? (
                          <Button
                            type="button"
                            variant="secondary"
                            className="h-auto shrink-0"
                            aria-expanded={qrFor === entry.platform}
                            onClick={() =>
                              setQrFor((current) =>
                                current === entry.platform
                                  ? null
                                  : entry.platform,
                              )
                            }
                          >
                            <QrCode className="h-4 w-4" />
                            {t("install.showQr")}
                          </Button>
                        ) : null}
                      </div>
                      {qrFor === entry.platform ? (
                        <PlatformQr platform={entry.platform} />
                      ) : null}
                    </div>
                  ))}
                </div>

                {audience === "desktop" ? (
                  <p className="text-xs leading-snug text-muted-foreground">
                    {t("install.desktopNote")}
                  </p>
                ) : null}

                {audience === "android" && android?.alternate ? (
                  <ApkFallback
                    asset={android.alternate}
                    releaseUrl={release.releaseUrl}
                  />
                ) : null}

                {audience === "ios" ? (
                  <>
                    <Callout
                      tone="info"
                      icon={<TabletSmartphone className="h-4 w-4" />}
                    >
                      {t("install.iosNote")}
                    </Callout>
                    {/* The better client, second and behind a spoiler: it is
                        hidden from the Russian App Store, so for most readers
                        the button leads nowhere and leading with it would send
                        them down a dead end. */}
                    {ios?.alternate ? (
                      <IosAmneziaOption asset={ios.alternate} />
                    ) : null}
                    {/*
                      iOS connects with a route profile but applies none of its
                      rules — a silent failure the user cannot see. Shown to the
                      iOS audience whatever the .conf policy is, because the
                      section that repeats it below can be switched off. See D8.
                    */}
                    <Callout
                      tone="warning"
                      icon={<TriangleAlert className="h-4 w-4" />}
                    >
                      {t("install.iosProfileWarning")}
                    </Callout>
                  </>
                ) : null}
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

          {confApplies ? (
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
            number={fixNumber}
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

  );
}

/**
 * The QR itself, revealed by the button beside a store link.
 *
 * The guide is usually read on a computer while the app has to end up on a
 * phone, so the store link is exactly the thing a camera should be able to
 * grab. Hidden until asked for — it is a shortcut, not a step.
 *
 * The image is rendered by the control API from the URL it resolved itself
 * (GET /api/client-releases/qr/:platform); this component holds no link, and
 * the panel already produces QR codes that way for key configs.
 */
function PlatformQr({
  platform,
  variant = "primary",
}: {
  platform: ClientPlatform;
  /** Which of the platform's two links to encode. */
  variant?: "primary" | "alternate";
}) {
  const { t } = useT();
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <img
        className="mx-auto h-44 w-44 rounded-md bg-white p-2"
        src={`/api/control/api/client-releases/qr/${platform}${
          variant === "alternate" ? "?variant=alternate" : ""
        }`}
        alt={t("install.qrAlt")}
      />
      <p className="text-center text-xs leading-snug text-muted-foreground">
        {t("install.qrHint")}
      </p>
    </div>
  );
}

/**
 * The walkthrough video for one audience, collapsed by default.
 *
 * Collapsed because the video is an aid, not the instruction: a player opened
 * on arrival pushes the actual steps below the fold. The summary row still
 * holds the place, so the video is visibly there rather than discovered by
 * accident.
 *
 * When no recording is configured the row still renders, with a line saying one
 * is coming. A silent gap would read as a broken page; a labelled empty slot
 * reads as "not yet". The URL comes from the portal policy, so an admin adds one
 * without a deploy and this component holds no link.
 */
function GuideVideo({ url }: { url: string | null }) {
  const { t } = useT();
  const embed = installVideoEmbed(url);
  return (
    <details className="group rounded-lg border bg-muted/30 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
        <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
        <Video className="h-4 w-4 shrink-0" aria-hidden="true" />
        {t("install.videoTitle")}
      </summary>
      <div className="mt-2.5">
        {!embed ? (
          <p className="text-xs leading-snug text-muted-foreground">
            {t("install.videoSoon")}
          </p>
        ) : embed.kind === "drive" ? (
          // Google Drive will not serve a file to a <video> tag — only its
          // /preview page embeds dependably — so a Drive link becomes a frame.
          // aspect-video keeps it responsive instead of a fixed height.
          <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border">
            <iframe
              className="absolute inset-0 h-full w-full border-0"
              src={embed.src}
              title={t("install.videoTitle")}
              allow="autoplay; fullscreen"
              allowFullScreen
              referrerPolicy="no-referrer"
            />
          </div>
        ) : (
          <video
            className="w-full rounded-md border border-border"
            src={embed.src}
            controls
            preload="metadata"
          />
        )}
      </div>
    </details>
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

/**
 * The AmneziaVPN listing, offered under the Default VPN button rather than
 * beside it. It is the same developers' real client and it does more, but it is
 * hidden from the Russian App Store by Roskomnadzor requirement -- so for most
 * of this panel's users the link simply will not open, and a second
 * equal-looking button would read as a choice when it is not one.
 */
function IosAmneziaOption({ asset }: { asset: ClientAsset }) {
  const { t } = useT();
  const [showQr, setShowQr] = React.useState(false);

  return (
    <details className="group rounded-lg border bg-muted/30 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
        <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
        {t("install.iosAmneziaTitle")}
      </summary>
      <div className="mt-2.5 space-y-2.5">
        <p className="text-xs leading-snug text-muted-foreground">
          {t("install.iosAmneziaBody")}
        </p>
        {/* The same QR affordance the store buttons above carry: this reader is
            on a computer, and the App Store opens on the phone. It matters more
            here than there -- the listing is region-locked, so they may well be
            scanning it onto a second device with a different Apple account. */}
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary" size="sm" className="w-fit">
            <a
              href={asset.url}
              target="_blank"
              rel="noreferrer"
              title={t("install.opensNewTab")}
            >
              <ExternalLink className="h-4 w-4" />
              {t("install.iosAmneziaOpen")}
            </a>
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-fit"
            aria-expanded={showQr}
            onClick={() => setShowQr((current) => !current)}
          >
            <QrCode className="h-4 w-4" />
            {t("install.showQr")}
          </Button>
        </div>
        {showQr ? <PlatformQr platform="ios" variant="alternate" /> : null}
      </div>
    </details>
  );
}

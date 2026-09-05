"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import { versionHref, versionLabel, type VersionLinkInfo } from "@/lib/version-link";

/**
 * The running build's identifier, linked to the code it was built from.
 *
 * Both places that show a version — the sidebar badge and the update card —
 * render through here, so the label and the destination stay the same in both.
 * It deliberately stays a version badge rather than becoming a loud link: the
 * mono text keeps its muted colour and only underlines on hover/focus.
 *
 * When the build carries no repository (`versionHref` returns null) the very
 * same markup renders as a plain span, so nothing shifts between a stamped and
 * an unstamped build.
 */
export function VersionLink({
  info,
  className,
}: {
  info: VersionLinkInfo;
  className?: string;
}) {
  const { t } = useT();
  const label = versionLabel(info);
  const href = versionHref(info);
  const classes = cn("font-mono", className);
  if (!href) {
    return (
      <span className={classes} title={info.commit ?? undefined}>
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={info.commit ?? undefined}
      aria-label={t("admin.versionLinkAria", { value: label })}
      className={cn(
        classes,
        "underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none",
      )}
    >
      {label}
    </a>
  );
}

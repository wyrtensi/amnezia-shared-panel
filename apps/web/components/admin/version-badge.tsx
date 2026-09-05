"use client";

import * as React from "react";
import { apiRequest } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";
import { VersionLink } from "@/components/admin/version-link";
import type { VersionLinkInfo } from "@/lib/version-link";

/** Small build-version line for the admin sidebar (GET /api/admin/version). */
export function VersionBadge() {
  const { t } = useT();
  const [info, setInfo] = React.useState<VersionLinkInfo | null>(null);

  React.useEffect(() => {
    apiRequest<VersionLinkInfo>("/api/admin/version")
      .then((data) => setInfo(data))
      .catch(() => setInfo(null));
  }, []);

  if (!info) return null;
  // The label is the release tag, or a short commit for a local "dev" build;
  // it links to that exact release or commit in the repository the image was
  // built from. The full commit stays available on hover. See VersionLink.
  return (
    <div className="px-3 pb-3 text-[11px] text-muted-foreground">
      {t("admin.version")}: <VersionLink info={info} />
    </div>
  );
}

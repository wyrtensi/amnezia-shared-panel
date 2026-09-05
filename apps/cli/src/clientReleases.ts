/**
 * Rendering for `amnezia-panel client-releases`.
 *
 * The panel resolves the newest AmneziaVPN client release itself (see
 * apps/control-api/src/clientReleases.ts) and caches it, so an operator needs a
 * way to see what users are actually being handed right now — including whether
 * the panel is serving the offline fallback because it could not reach GitHub.
 *
 * Shapes are declared structurally rather than imported from
 * @amnezia/contracts: apps/cli deliberately has no runtime dependencies, and
 * main.ts already re-declares the API shapes it consumes. The logic lives here
 * rather than in main.ts because main.ts self-executes and cannot be imported
 * by a test.
 */

export type CliClientAsset = {
  url: string;
  kind: string;
  fileName: string | null;
  sizeBytes: number | null;
};

export type CliClientPlatformDownload = {
  platform: string;
  primary: CliClientAsset;
  alternate: CliClientAsset | null;
};

export type CliClientRelease = {
  version: string | null;
  releaseUrl: string;
  publishedAt: string | null;
  fallback: boolean;
  resolvedAt: string;
  downloads: CliClientPlatformDownload[];
};

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Rounded download size, or "-" when the link is a store or a release page. */
export function formatBytes(raw: number | null): string {
  if (raw === null || !Number.isFinite(raw)) return "-";
  let amount = raw;
  let unit = 0;
  while (amount >= 1024 && unit < BYTE_UNITS.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit > 1 ? 1 : 0)} ${BYTE_UNITS[unit]}`;
}

export const CLIENT_RELEASE_COLUMNS = [
  "platform",
  "role",
  "kind",
  "file",
  "size",
  "url",
];

const row = (
  platform: string,
  role: "primary" | "alternate",
  asset: CliClientAsset,
): Record<string, string> => ({
  platform,
  role,
  kind: asset.kind,
  file: asset.fileName ?? "-",
  size: formatBytes(asset.sizeBytes),
  url: asset.url,
});

/**
 * One row per download, in the order the panel returns them. A platform with an
 * alternate (today: Android, whose Play link is backed by a direct APK) emits a
 * second row so the operator can check both links at once.
 */
export function clientReleaseRows(
  release: CliClientRelease,
): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  for (const download of release.downloads) {
    rows.push(row(download.platform, "primary", download.primary));
    if (download.alternate) {
      rows.push(row(download.platform, "alternate", download.alternate));
    }
  }
  return rows;
}

/**
 * The header line above the table: which release the panel resolved, when, and
 * — the fact that actually matters when something looks wrong — whether it is
 * serving the offline fallback instead of a real release.
 */
export function clientReleaseSummary(release: CliClientRelease): string {
  const version = release.version ?? "unknown";
  const state = release.fallback
    ? "OFFLINE FALLBACK (GitHub unreachable; links point at the releases page)"
    : "resolved";
  return [
    `version:    ${version}`,
    `state:      ${state}`,
    `release:    ${release.releaseUrl}`,
    `published:  ${release.publishedAt ?? "unknown"}`,
    `resolvedAt: ${release.resolvedAt}`,
  ].join("\n");
}

/** Shape of `GET /api/admin/version`, as far as the line below needs it. */
export type CliVersionInfo = {
  version?: string;
  commit?: string | null;
  /**
   * The AWG 3.1 client floor the panel advertises. Served by the panel rather
   * than copied here, so the CLI, the wizard hint and the install guide can
   * never disagree; a panel older than that change omits it.
   */
  minAwg3ClientVersion?: string;
  /**
   * The repository this build came from, stamped at image build time. The
   * admin UI turns it into a link on the version; here it is the answer to
   * "which code is this panel actually running". Absent on an older panel.
   */
  repositoryUrl?: string | null;
};

/**
 * The default `version` line. Missing fields render as "?" — the panel may be
 * older than the field, and a literal "undefined" would read as a value.
 */
export function formatVersionLine(info: CliVersionInfo): string {
  return [
    `version: ${info.version ?? "?"}`,
    `commit: ${info.commit ?? "?"}`,
    `awg3-client-floor: ${info.minAwg3ClientVersion ?? "?"}`,
    `repo: ${info.repositoryUrl ?? "?"}`,
  ].join("   ");
}

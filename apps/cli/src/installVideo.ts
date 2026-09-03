/**
 * Structural copy of `installVideoEmbed` from @amnezia/contracts.
 *
 * The CLI declares no runtime dependencies on purpose (the plan's D7), so it
 * re-states small facts rather than importing the workspace package — the same
 * trade-off `deviceProfiles.ts` and `args.ts` already make. Both copies are
 * pinned by tests over the same table of cases; change one, change the other.
 *
 * Why it exists here at all: `policy-set --video-<audience>=…` should refuse a
 * URL the panel cannot play at the moment it is typed, rather than storing it
 * and leaving the guide showing a placeholder with no explanation.
 */
export type CliVideoEmbed = { kind: "drive" | "file"; src: string };

const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

export const cliInstallVideoEmbed = (
  value: string | null | undefined,
): CliVideoEmbed | null => {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.replace(/^www\./, "");
  if (host === "drive.google.com") {
    const fromPath = /^\/file\/d\/([^/]+)/.exec(url.pathname)?.[1];
    const id = fromPath ?? url.searchParams.get("id") ?? "";
    if (!DRIVE_FILE_ID.test(id)) return null;
    return { kind: "drive", src: `https://drive.google.com/file/d/${id}/preview` };
  }
  return { kind: "file", src: url.href };
};

/** One line describing how a value will actually play, for the command output. */
export const describeVideoTarget = (
  audience: string,
  value: string | null,
): string => {
  if (value === null) return `${audience}: cleared`;
  const embed = cliInstallVideoEmbed(value);
  if (!embed) return `${audience}: NOT PLAYABLE`;
  return embed.kind === "drive"
    ? `${audience}: Google Drive preview (${embed.src})`
    : `${audience}: direct video file`;
};

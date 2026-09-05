/**
 * Where the version shown in the admin UI points.
 *
 * The panel already knows its own build: `GET /api/admin/version` serves the
 * version, the commit and — since the release workflow stamps `APP_REPO_URL` —
 * the repository the image was built from. The repository is a deployment fact
 * (a fork publishes its own images from its own repo), so it travels with the
 * build info instead of being frozen into this bundle. A build that carries no
 * repository leaves the version as plain text rather than linking at someone
 * else's code.
 */

export type VersionLinkInfo = {
  version?: string | null;
  commit?: string | null;
  repositoryUrl?: string | null;
};

/**
 * A release tag: `v0.9.24` or `0.9.24`. Anything else — "dev", or the short
 * sha `scripts/deploy.sh` stamps into a locally built image — is a build stamp
 * with no release page behind it, so such a build links by commit instead.
 */
const RELEASE_TAG = /^v?\d+\.\d+\.\d+/;

/**
 * The href for a build: its release page when the version is a tag, the commit
 * otherwise, and the repository root when neither is known. `null` when the
 * build carries no repository at all — the caller renders plain text then.
 */
export function versionHref(info: VersionLinkInfo): string | null {
  const repo = info.repositoryUrl?.trim().replace(/\/+$/, "");
  if (!repo) return null;
  const version = info.version?.trim();
  if (version && RELEASE_TAG.test(version)) {
    return `${repo}/releases/tag/${encodeURIComponent(version)}`;
  }
  const commit = info.commit?.trim();
  if (commit) return `${repo}/commit/${encodeURIComponent(commit)}`;
  return repo;
}

/**
 * What the badge says out loud: the release tag, or a short commit for a build
 * that has no tag. Shared by the sidebar badge and the update card so the two
 * can never disagree about which identifier names the running build.
 */
export function versionLabel(info: VersionLinkInfo): string {
  const version = info.version?.trim();
  if (version && version !== "dev") return version;
  const commit = info.commit?.trim();
  return commit ? commit.slice(0, 7) : "dev";
}

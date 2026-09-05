/**
 * Reading a rule version's `source_url` back into something an admin can name.
 *
 * `route_rule_versions.source_url` is written by the worker as
 * `sources.map((s) => s.url).join(" ")` (apps/worker/src/rules.ts), so a
 * version merged from several feeds carries several URLs in one column. Split
 * on whitespace and every version — one source or many — reads the same way.
 *
 * The label is DERIVED, never looked up in a table of known feeds. `RULE_FEEDS`
 * is per-deployment configuration: any table of "this URL means RoscomVPN"
 * would be wrong the moment an operator points a profile somewhere else, and
 * wrong silently, which is exactly how the page came to be titled after a
 * provider that supplies only one of its two lists. What the rules below encode
 * instead is the SHAPE of URLs, which does not depend on who is being fetched:
 *
 *   - On a code forge or a git CDN the identity is the repository, not the
 *     host: every project on GitHub shares `github.com`, so the host says
 *     nothing. Take the repo name out of the path.
 *   - Anywhere else the host is the identity, minus the label that names a
 *     delivery role (`www`, `cdn`, `raw`, …) rather than a project.
 *
 * The full URL always travels with the label so a derivation that reads oddly
 * for some future feed is never the only thing the admin can see.
 */

/**
 * Hosts whose path carries `<owner>/<repo>`, and how many leading path
 * segments to skip before the owner. Not a list of feeds — a list of forge URL
 * layouts, which is stable no matter what anyone points RULE_FEEDS at.
 */
const FORGE_PATH_LAYOUTS: Record<string, number> = {
  "github.com": 0,
  "raw.githubusercontent.com": 0,
  "gitlab.com": 0,
  "codeberg.org": 0,
  "bitbucket.org": 0,
  // jsDelivr addresses a repo as /gh/<owner>/<repo>@<ref>/<path>.
  "cdn.jsdelivr.net": 1,
  "fastly.jsdelivr.net": 1,
  "raw.githack.com": 0,
  "statically.io": 1,
};

/**
 * Host labels that describe how a file is served rather than who serves it.
 * Skipped when picking the name out of a hostname.
 */
const DELIVERY_LABELS = new Set([
  "www",
  "cdn",
  "raw",
  "static",
  "assets",
  "files",
  "file",
  "dl",
  "download",
  "downloads",
  "api",
  "data",
  "feed",
  "feeds",
  "list",
  "lists",
  "mirror",
  "mirrors",
  "release",
  "releases",
  "s3",
  "storage",
]);

/** Split one stored `source_url` cell into the URLs it actually holds. */
export const splitSourceUrls = (sourceUrl: string | null | undefined): string[] =>
  (sourceUrl ?? "").split(/\s+/).filter(Boolean);

/**
 * A short, human-readable name for one source URL.
 *
 * Falls back to the host, and then to the raw string, so a URL this cannot
 * parse still renders as something rather than as an empty cell.
 */
export const sourceName = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);

  const skip = FORGE_PATH_LAYOUTS[host];
  if (skip !== undefined) {
    // <skip> filler segments, then <owner>, then <repo>. jsDelivr pins a ref
    // with `@`, which is not part of the repository's name.
    const repo = segments[skip + 1];
    if (repo) return repo.split("@")[0] ?? repo;
    // A forge URL with no repository in it: the owner alone is still better
    // than "github.com", and the host is the last resort.
    const owner = segments[skip];
    if (owner) return owner.split("@")[0] ?? owner;
    return host;
  }

  const labels = host.split(".");
  // Drop the public suffix (`org`, `net`, `co.uk` → keep it simple and drop
  // one label) and any delivery-role prefix, then take the first thing left:
  // `iplist.opencck.org` is iplist, `lists.example.com` is lists, and a bare
  // `example.com` is example.
  const named = labels
    .slice(0, Math.max(1, labels.length - 1))
    .filter((label) => !DELIVERY_LABELS.has(label));
  return named[0] ?? labels[0] ?? host;
};

export type RuleSourceRef = { url: string; name: string };

/** Every source behind one stored `source_url`, de-duplicated by URL. */
export const ruleSources = (
  sourceUrl: string | null | undefined,
): RuleSourceRef[] => {
  const seen = new Set<string>();
  const refs: RuleSourceRef[] = [];
  for (const url of splitSourceUrls(sourceUrl)) {
    if (seen.has(url)) continue;
    seen.add(url);
    refs.push({ url, name: sourceName(url) });
  }
  return refs;
};

/**
 * Every distinct source across a set of versions, in first-seen order — what a
 * profile's header shows as "these feeds supply this list".
 *
 * Callers pass the profile's versions newest-first, so the feeds in use today
 * lead, and a feed that only older versions were built from still appears
 * rather than silently dropping out of its own history.
 */
export const distinctSources = (
  sourceUrls: Array<string | null | undefined>,
): RuleSourceRef[] => {
  const refs: RuleSourceRef[] = [];
  for (const sourceUrl of sourceUrls) {
    for (const ref of ruleSources(sourceUrl)) {
      if (!refs.some((seen) => seen.url === ref.url)) refs.push(ref);
    }
  }
  return refs;
};

import { z } from "zod";
import {
  clientReleaseSchema,
  type ClientAsset,
  type ClientPlatformDownload,
  type ClientRelease,
} from "@amnezia/contracts";

/**
 * Where users get the AmneziaVPN client, resolved from the newest
 * amnezia-client release.
 *
 * A panel user may sit behind a network that cannot reach GitHub, and
 * AGENTS.md keeps business logic out of apps/web, so the panel resolves this
 * server-side, caches it, and serves the same answer to everyone.
 *
 * Modelled on the worker's rule-feed fetcher (apps/worker/src/rules.ts): an
 * injectable fetch, an abort timeout, an explicit non-2xx failure, a byte cap
 * and zod validation of the remote body — the right shape for an untrusted
 * third-party document, as opposed to cloudflareApi.ts, which is an
 * authenticated first-party client. What this adds is request-path behaviour
 * the worker has no need for: a TTL cache, single-flight refresh, and a
 * guarantee that a GitHub failure never reaches the user.
 */

const RELEASE_API_URL =
  "https://api.github.com/repos/amnezia-vpn/amnezia-client/releases/latest";

/**
 * GitHub's permanent redirect to the newest release page. It carries no
 * version, so nothing in this repo goes stale when a release ships. Used by the
 * offline fallback.
 */
const RELEASES_LATEST_URL =
  "https://github.com/amnezia-vpn/amnezia-client/releases/latest";

const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=org.amnezia.vpn";

// Two iOS listings, and which one a user can install depends on where their
// Apple account is registered. AmneziaVPN is the real client; it is hidden from
// the Russian App Store by Roskomnadzor requirement (and from the Chinese one),
// which is why DefaultVPN -- the same developers under another listing name --
// exists and is the primary button here. The guide says both, in that order.
const APP_STORE_URL = "https://apps.apple.com/us/app/defaultvpn/id6744725017";
const AMNEZIA_APP_STORE_URL =
  "https://apps.apple.com/us/app/amneziavpn/id1600529900";

/**
 * How long a resolved release is served before GitHub is asked again.
 * AmneziaVPN ships roughly one release every few weeks, so six hours of
 * staleness is invisible, while four calls a day per panel is nothing against
 * GitHub's unauthenticated budget (60 requests/hour/IP, shared with the
 * worker's feed fetches). A panel restart — what the in-panel Update button
 * causes — clears the cache, which is exactly when a fresh answer is wanted.
 */
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a failure is remembered before retrying. Short enough to recover on
 * the next dialog open after a blip, long enough that a panel with no route to
 * GitHub spends one timeout per quarter hour instead of one per page view.
 */
const FAILURE_TTL_MS = 15 * 60 * 1000;

/** A user is waiting on this, so give up early rather than hang the dialog. */
const FETCH_TIMEOUT_MS = 5_000;

/** releases/latest is tens of KB of JSON; far more than this is not our document. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Release asset names, verified against release 5.0.1.5 on 2026-09-02:
 *   AmneziaVPN_<version>_windows_x64.exe
 *   AmneziaVPN_<version>_macos_x64.pkg
 *   AmneziaVPN_<version>_linux_x64.run
 *   AmneziaVPN_<version>_android11+_arm64-v8a.apk
 * The Android release also carries armeabi-v7a / x86 / x86_64 builds and an
 * android9-10 variant of each. We link one: arm64 is every Android phone sold
 * since roughly 2019 and Android 11+ covers the large majority of active
 * devices; the guide links the release page beside it for everything else.
 * The literal "+" is escaped here and arrives percent-encoded in the download
 * URL, which is why the URL is taken from the payload verbatim, never rebuilt.
 */
const ASSET_PATTERNS = {
  windows: /_windows_x64\.exe$/i,
  macos: /_macos_x64\.pkg$/i,
  linux: /_linux_x64\.run$/i,
  android: /_android11\+_arm64-v8a\.apk$/i,
} as const;

const githubReleaseSchema = z.object({
  tag_name: z.string().min(1).max(40),
  html_url: z.url(),
  published_at: z.string().min(1).nullish(),
  assets: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        browser_download_url: z.url(),
        size: z.int().nonnegative(),
      }),
    )
    .default([]),
});

type GitHubRelease = z.infer<typeof githubReleaseSchema>;

// Factories, never shared literals: handing out a module-level object would let
// one caller's mutation corrupt every later response (the lesson from
// resolveRuleFeeds in apps/worker/src/rules.ts).
const storeAsset = (url: string): ClientAsset => ({
  url,
  kind: "store",
  fileName: null,
  sizeBytes: null,
});

const releasePageAsset = (url: string): ClientAsset => ({
  url,
  kind: "releasePage",
  fileName: null,
  sizeBytes: null,
});

const installerAsset = (
  release: GitHubRelease,
  pattern: RegExp,
): ClientAsset | null => {
  const match = release.assets.find((asset) => pattern.test(asset.name));
  return match
    ? {
        url: match.browser_download_url,
        kind: "installer",
        fileName: match.name,
        sizeBytes: match.size,
      }
    : null;
};

const toIsoOrNull = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

/**
 * Map a GitHub release onto the panel's answer. A renamed or missing asset
 * degrades that one platform to the release page rather than failing the whole
 * resolve — a naming change upstream must not blank the guide.
 */
const toClientRelease = (release: GitHubRelease, now: Date): ClientRelease => {
  const page = () => releasePageAsset(release.html_url);
  const downloads: ClientPlatformDownload[] = [
    {
      platform: "windows",
      primary: installerAsset(release, ASSET_PATTERNS.windows) ?? page(),
      alternate: null,
    },
    {
      platform: "macos",
      primary: installerAsset(release, ASSET_PATTERNS.macos) ?? page(),
      alternate: null,
    },
    {
      platform: "linux",
      primary: installerAsset(release, ASSET_PATTERNS.linux) ?? page(),
      alternate: null,
    },
    {
      platform: "android",
      primary: storeAsset(PLAY_STORE_URL),
      // Google Play is unreachable for some users; the APK is the way round it.
      alternate: installerAsset(release, ASSET_PATTERNS.android) ?? page(),
    },
    {
      platform: "ios",
      primary: storeAsset(APP_STORE_URL),
      // Not a fallback for a broken primary, as Android's APK is: a different
      // app, better where it can be installed at all.
      alternate: storeAsset(AMNEZIA_APP_STORE_URL),
    },
  ];

  // Parse our own output: a URL GitHub hands us that the contract refuses is a
  // failure, and failures are caught by the caller and turned into a fallback.
  return clientReleaseSchema.parse({
    version: release.tag_name,
    releaseUrl: release.html_url,
    publishedAt: toIsoOrNull(release.published_at),
    fallback: false,
    resolvedAt: now.toISOString(),
    downloads,
  });
};

/**
 * Last resort, used only when nothing has ever resolved: the two store links
 * plus GitHub's permanent latest redirect. No version literal anywhere, so it
 * cannot rot; `fallback: true` lets the UI say the links may not be newest.
 */
const pinnedFallback = (now: Date): ClientRelease => ({
  version: null,
  releaseUrl: RELEASES_LATEST_URL,
  publishedAt: null,
  fallback: true,
  resolvedAt: now.toISOString(),
  downloads: [
    {
      platform: "windows",
      primary: releasePageAsset(RELEASES_LATEST_URL),
      alternate: null,
    },
    {
      platform: "macos",
      primary: releasePageAsset(RELEASES_LATEST_URL),
      alternate: null,
    },
    {
      platform: "linux",
      primary: releasePageAsset(RELEASES_LATEST_URL),
      alternate: null,
    },
    {
      platform: "android",
      primary: storeAsset(PLAY_STORE_URL),
      alternate: releasePageAsset(RELEASES_LATEST_URL),
    },
    {
      platform: "ios",
      primary: storeAsset(APP_STORE_URL),
      alternate: storeAsset(AMNEZIA_APP_STORE_URL),
    },
  ],
});

export interface ClientReleaseResolver {
  /** The current answer: a cached snapshot, or a fresh resolve when it is due. */
  get(): Promise<ClientRelease>;
  /**
   * Drop the cached deadline and resolve again now. Backs the admin refresh
   * route and the CLI's --refresh, so an operator whose host briefly lost
   * egress does not have to wait out the failure window.
   */
  refresh(): Promise<ClientRelease>;
}

export type ClientReleaseResolverOptions = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  apiUrl?: string;
  successTtlMs?: number;
  failureTtlMs?: number;
  timeoutMs?: number;
};

export function createClientReleaseResolver(
  options: ClientReleaseResolverOptions = {},
): ClientReleaseResolver {
  const {
    fetchImpl = fetch,
    now = () => new Date(),
    apiUrl = RELEASE_API_URL,
    successTtlMs = SUCCESS_TTL_MS,
    failureTtlMs = FAILURE_TTL_MS,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = options;

  /** The last snapshot GitHub actually gave us, kept across failures. */
  let lastGood: ClientRelease | null = null;
  /** What `get` serves until `refreshAfter`; may be `lastGood` or the pin. */
  let served: ClientRelease | null = null;
  let refreshAfter = 0;
  let inFlight: Promise<ClientRelease> | null = null;

  const fetchRelease = async (): Promise<ClientRelease> => {
    const response = await fetchImpl(apiUrl, {
      headers: {
        accept: "application/vnd.github+json",
        // GitHub rejects API requests without one.
        "user-agent": "amnezia-shared-panel",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // 403/429 here is the rate limit; treated like any other failure.
      throw new Error(
        `GitHub release lookup failed with status ${response.status}`,
      );
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("GitHub release response is too large");
    }
    return toClientRelease(githubReleaseSchema.parse(JSON.parse(body)), now());
  };

  const refreshOnce = async (): Promise<ClientRelease> => {
    try {
      const resolved = await fetchRelease();
      lastGood = resolved;
      served = resolved;
      refreshAfter = now().getTime() + successTtlMs;
      return resolved;
    } catch {
      // A GitHub failure must never reach the user: a stale-but-real snapshot
      // beats the pin, and the pin beats an error. A failure is never final —
      // only a success sets the long deadline, so the next cycle tries again
      // and the pin is replaced the moment GitHub answers.
      served = lastGood ?? pinnedFallback(now());
      refreshAfter = now().getTime() + failureTtlMs;
      return served;
    } finally {
      inFlight = null;
    }
  };

  const current = (): Promise<ClientRelease> => {
    if (served && now().getTime() < refreshAfter) return Promise.resolve(served);
    // Collapse a burst of dialog opens into a single upstream request.
    inFlight ??= refreshOnce();
    return inFlight;
  };

  return {
    get: current,
    refresh() {
      // Expire the deadline, then take the normal path: an operator asking for
      // a refresh while one is already in flight joins it rather than firing a
      // second request at GitHub.
      refreshAfter = 0;
      return current();
    },
  };
}

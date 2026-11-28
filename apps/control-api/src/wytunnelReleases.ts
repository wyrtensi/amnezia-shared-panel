import { z } from "zod";
import {
  WYTUNNEL_DEFAULT_REPO,
  WYTUNNEL_FALLBACK_TAG,
  wytunnelReleaseSchema,
  type WytunnelRelease,
  type WytunnelReleaseAsset,
} from "@amnezia/contracts";

/**
 * Resolves the latest WyTunnel binary release from GitHub Releases (or uses a
 * pinned `WYTUNNEL_RELEASE_VERSION`), caches it in memory with single-flight
 * deduplication, and guarantees graceful fallback on network errors or 404.
 */

const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const SUMS_TIMEOUT_MS = 3_000;
const MAX_RELEASE_BYTES = 512 * 1024;
const MAX_SUMS_BYTES = 16 * 1024;

const AMD64_TARBALL = "wytunnel-linux-amd64-musl.tar.gz";
const ARM64_TARBALL = "wytunnel-linux-arm64-musl.tar.gz";

const githubReleaseSchema = z.object({
  tag_name: z.string().min(1).max(64),
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

const readBoundedText = async (response: Response, maxBytes: number): Promise<string> => {
  const lenRaw = response.headers.get("content-length");
  const len = lenRaw ? Number(lenRaw) : null;
  if (len !== null && Number.isFinite(len) && len > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("GitHub WyTunnel release response exceeded byte cap");
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error("GitHub WyTunnel release response exceeded byte cap");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("GitHub WyTunnel release response exceeded byte cap");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
};

const parseSha256Sums = (body: string): Map<string, string> => {
  const sums = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?([^\s]+)\s*$/.exec(line.trim());
    if (match) {
      sums.set(match[2]!, match[1]!.toLowerCase());
    }
  }
  return sums;
};

export type WytunnelReleaseResolverOptions = {
  repository?: string;
  pinnedVersion?: string;
  githubToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type WytunnelReleaseResolver = {
  get: () => Promise<WytunnelRelease>;
  refresh: () => Promise<WytunnelRelease>;
};

export const createWytunnelReleaseResolver = (
  options: WytunnelReleaseResolverOptions = {},
): WytunnelReleaseResolver => {
  const repository = options.repository?.trim() || WYTUNNEL_DEFAULT_REPO;
  const pinnedTag = options.pinnedVersion?.trim() || undefined;
  const githubToken = options.githubToken?.trim() || undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());

  const fallback = (): WytunnelRelease =>
    wytunnelReleaseSchema.parse({
      repository,
      tag: pinnedTag ?? WYTUNNEL_FALLBACK_TAG,
      version: (pinnedTag ?? WYTUNNEL_FALLBACK_TAG).replace(/^v/i, ""),
      htmlUrl: pinnedTag
        ? `https://github.com/${repository}/releases/tag/${encodeURIComponent(pinnedTag)}`
        : `https://github.com/${repository}/releases`,
      publishedAt: null,
      source: pinnedTag ? "pinned_env" : "fallback",
      assets: { amd64: null, arm64: null },
    });

  let cached: { value: WytunnelRelease; expiresAt: number } | null = null;
  let inFlight: Promise<WytunnelRelease> | null = null;

  const fetchLatest = async (): Promise<WytunnelRelease> => {
    if (pinnedTag) return fallback();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "amnezia-shared-panel",
      };
      if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

      const res = await fetchImpl(
        `https://api.github.com/repos/${repository}/releases/latest`,
        { headers, signal: controller.signal },
      );
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`GitHub releases/latest returned HTTP ${res.status}`);
      }
      const raw = await readBoundedText(res, MAX_RELEASE_BYTES);
      const release = githubReleaseSchema.parse(JSON.parse(raw));

      let sums = new Map<string, string>();
      const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS");
      if (sumsAsset) {
        const sumsController = new AbortController();
        const sumsTimer = setTimeout(() => sumsController.abort(), SUMS_TIMEOUT_MS);
        try {
          const sumsRes = await fetchImpl(sumsAsset.browser_download_url, {
            headers: { "User-Agent": "amnezia-shared-panel" },
            signal: sumsController.signal,
          });
          if (sumsRes.ok) {
            const sumsBody = await readBoundedText(sumsRes, MAX_SUMS_BYTES);
            sums = parseSha256Sums(sumsBody);
          } else {
            await sumsRes.body?.cancel().catch(() => undefined);
          }
        } catch {
          // Non-fatal: installers fetch SHA256SUMS directly if absent from cached metadata.
        } finally {
          clearTimeout(sumsTimer);
        }
      }

      const pickAsset = (name: string): WytunnelReleaseAsset | null => {
        const hit = release.assets.find((a) => a.name === name);
        return hit
          ? {
              name: hit.name,
              url: hit.browser_download_url,
              size: hit.size,
              sha256: sums.get(hit.name) ?? null,
            }
          : null;
      };

      const parsed = wytunnelReleaseSchema.parse({
        repository,
        tag: release.tag_name,
        version: release.tag_name.replace(/^v/i, ""),
        htmlUrl: release.html_url,
        publishedAt: release.published_at ?? null,
        source: "github",
        assets: {
          amd64: pickAsset(AMD64_TARBALL),
          arm64: pickAsset(ARM64_TARBALL),
        },
      });
      cached = { value: parsed, expiresAt: now() + SUCCESS_TTL_MS };
      return parsed;
    } catch {
      const value = fallback();
      cached = { value, expiresAt: now() + FAILURE_TTL_MS };
      return value;
    } finally {
      clearTimeout(timer);
    }
  };

  const get = async (): Promise<WytunnelRelease> => {
    if (pinnedTag) return fallback();
    if (cached && now() < cached.expiresAt) return cached.value;
    if (!inFlight) {
      inFlight = fetchLatest().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };

  const refresh = async (): Promise<WytunnelRelease> => {
    cached = null;
    inFlight = null;
    return get();
  };

  return { get, refresh };
};

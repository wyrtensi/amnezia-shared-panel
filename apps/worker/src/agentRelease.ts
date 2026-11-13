import { createHash } from "node:crypto";

import { isPublishableAgentImage } from "@amnezia/contracts";

/**
 * The node-agent image the panel offers nodes.
 *
 * The admin never pastes a digest and the node is never handed a tag: a tag is
 * mutable, so what gets installed could differ from what was confirmed. The
 * worker resolves the current published version to its digest here, and the
 * panel passes that exact digest through the job payload.
 */
export type AgentRelease = {
  repository: string;
  version: string;
  digest: string;
  /** `repository@digest` - the only form a node accepts. */
  image: string;
};
export type NodeAgentRelease = AgentRelease;

/**
 * What makes a published tag offerable beyond being a release. The node-agent
 * has none; the bridge-agent filters on a minimum version and on the API
 * version its image declares.
 */
export type ReleaseFilter = {
  /** Release tags below this semver are never offered. */
  minVersion?: string;
  /**
   * OCI image label that names the API version the image speaks. When the image
   * carries it the value must be in `supportedApiVersions`; an image without
   * the label is judged by `minVersion` alone.
   */
  apiVersionLabel?: { name: string; supportedApiVersions: readonly number[] };
  /** How many of the newest tags to inspect before giving up. */
  maxCandidates?: number;
};

type FetchImpl = typeof fetch;

const REGISTRY = "https://ghcr.io";
const DIGEST_HEADER = "docker-content-digest";
const TIMEOUT_MS = 10_000;

/** `1.1.3` sorts after `1.1.2`, and `1.10.0` after `1.9.0`. */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const compareVersions = (a: string, b: string): number => {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (!left || !right) return a.localeCompare(b);
  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(left[index]) - Number(right[index]);
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * The newest release tag, ignoring everything else the repository holds.
 *
 * The release workflow also publishes `sha-<short sha>` on a manual run, and
 * those are deliberately not offered: they are not releases, and nothing orders
 * them against a version.
 */
export const pickLatestReleaseTag = (tags: string[]): string | null =>
  releaseTagsNewestFirst(tags)[0] ?? null;

/** Release tags, newest first; anything that is not `X.Y.Z` is dropped. */
export const releaseTagsNewestFirst = (tags: string[]): string[] =>
  tags.filter((tag) => SEMVER.test(tag)).sort((a, b) => compareVersions(b, a));

/** The repository path GHCR uses, e.g. `owner/repo/node-agent`. */
const registryPath = (repository: string): string | null => {
  const prefix = "ghcr.io/";
  if (!repository.startsWith(prefix)) return null;
  const path = repository.slice(prefix.length);
  return path.length > 0 ? path : null;
};

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

type Manifest = {
  manifests?: { digest?: unknown; platform?: { os?: unknown } }[];
  config?: { digest?: unknown };
};

/** A manifest or config body larger than this is not read (they are a few KB). */
const MAX_BODY_BYTES = 1_048_576;
const DIGEST_FORMAT = /^sha256:[0-9a-f]{64}$/;

/**
 * What the image says about its API version. `walk_failed` means the registry
 * did not give a verifiable answer: the caller must not treat that as "no
 * label", or a broken walk would offer an image nobody inspected.
 */
type LabelResult =
  | { status: "label"; value: string }
  | { status: "no_label" }
  | { status: "walk_failed" };

/**
 * Fetch `url` and return its parsed JSON only if the body is within the byte
 * limit and its sha256 equals `expectedDigest`. A tag moved between steps, a
 * registry that serves other bytes than it names, and an oversized body all
 * come back as null.
 */
const fetchVerified = async (
  request: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
  expectedDigest: string,
  authorized: Record<string, string>,
  accept?: string,
): Promise<unknown> => {
  if (!DIGEST_FORMAT.test(expectedDigest)) return null;
  const response = await request(url, {
    headers: { ...authorized, ...(accept ? { accept } : {}) },
  });
  if (!response.ok) return null;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) return null;
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== expectedDigest) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
};

/**
 * Read label `name` of the image whose top-level manifest digest is
 * `imageDigest`, walking index -> linux manifest -> config blob by DIGEST and
 * verifying each body against the digest that referenced it. The caller offers
 * exactly `imageDigest`, so what was inspected is what gets installed.
 */
const readLabel = async (
  request: (url: string, init?: RequestInit) => Promise<Response>,
  path: string,
  authorized: Record<string, string>,
  imageDigest: string,
  name: string,
): Promise<LabelResult> => {
  const failed: LabelResult = { status: "walk_failed" };
  let manifest = (await fetchVerified(
    request,
    `${REGISTRY}/v2/${path}/manifests/${imageDigest}`,
    imageDigest,
    authorized,
    MANIFEST_ACCEPT,
  )) as Manifest | null;
  if (!manifest) return failed;
  if (Array.isArray(manifest.manifests)) {
    const linux = manifest.manifests.find(
      (entry) => entry.platform?.os === "linux" && typeof entry.digest === "string",
    );
    if (!linux) return failed;
    const linuxDigest = String(linux.digest);
    manifest = (await fetchVerified(
      request,
      `${REGISTRY}/v2/${path}/manifests/${linuxDigest}`,
      linuxDigest,
      authorized,
      MANIFEST_ACCEPT,
    )) as Manifest | null;
    if (!manifest) return failed;
  }
  const configDigest = manifest.config?.digest;
  if (typeof configDigest !== "string") return failed;
  const config = (await fetchVerified(
    request,
    `${REGISTRY}/v2/${path}/blobs/${configDigest}`,
    configDigest,
    authorized,
  )) as { config?: { Labels?: Record<string, unknown> | null } } | null;
  if (!config) return failed;
  const value = config.config?.Labels?.[name];
  return typeof value === "string" ? { status: "label", value } : { status: "no_label" };
};

/**
 * Resolve `repository` to its newest published release that passes `filter`,
 * and that release's digest, using the registry's anonymous pull token. Returns
 * null when the package is missing, private, nothing passes the filter, or the
 * registry is unreachable - the caller must degrade to "cannot resolve the
 * current image", never to a tag.
 */
export const resolveAgentRelease = async (
  repository: string,
  filter: ReleaseFilter = {},
  fetchImpl: FetchImpl = fetch,
): Promise<AgentRelease | null> => {
  const path = registryPath(repository.trim());
  if (!path) return null;

  const request = async (url: string, init?: RequestInit): Promise<Response> =>
    fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

  const tokenResponse = await request(
    `${REGISTRY}/token?scope=${encodeURIComponent(`repository:${path}:pull`)}&service=ghcr.io`,
  );
  if (!tokenResponse.ok) return null;
  const tokenBody = (await tokenResponse.json()) as { token?: unknown };
  const token = typeof tokenBody.token === "string" ? tokenBody.token : null;
  if (!token) return null;

  const authorized = { authorization: `Bearer ${token}` };

  const tagsResponse = await request(`${REGISTRY}/v2/${path}/tags/list?n=1000`, {
    headers: authorized,
  });
  if (!tagsResponse.ok) return null;
  const tagsBody = (await tagsResponse.json()) as { tags?: unknown };
  const tags = Array.isArray(tagsBody.tags)
    ? tagsBody.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const minVersion = filter.minVersion;
  const candidates = releaseTagsNewestFirst(tags)
    .filter((tag) => minVersion === undefined || compareVersions(tag, minVersion) >= 0)
    .slice(0, filter.maxCandidates ?? 1);

  for (const version of candidates) {
    // Resolve the digest FIRST, then inspect that digest: a tag re-pushed
    // between steps can never make us offer bytes we did not look at.
    // HEAD, not GET: the digest is a response header.
    const manifestResponse = await request(
      `${REGISTRY}/v2/${path}/manifests/${version}`,
      { method: "HEAD", headers: { ...authorized, accept: MANIFEST_ACCEPT } },
    );
    if (!manifestResponse.ok) {
      if (!filter.apiVersionLabel) return null;
      continue;
    }
    const digest = manifestResponse.headers.get(DIGEST_HEADER);
    if (!digest) {
      if (!filter.apiVersionLabel) return null;
      continue;
    }

    const image = `${repository.trim()}@${digest}`;
    // The same check the node will make. Resolving to something a node would
    // refuse is a bug worth catching here, where it is one log line, rather than
    // on the node, where it is a failed update on a live host.
    if (!isPublishableAgentImage(image, repository.trim())) return null;

    if (filter.apiVersionLabel) {
      const result = await readLabel(request, path, authorized, digest, filter.apiVersionLabel.name);
      // A broken walk and a present-but-unsupported label both rule the tag
      // out; only a successfully read config WITHOUT the label falls back to
      // the minimum version applied above.
      if (result.status === "walk_failed") continue;
      if (
        result.status === "label" &&
        !filter.apiVersionLabel.supportedApiVersions.includes(Number(result.value))
      ) {
        continue;
      }
    }

    return { repository: repository.trim(), version, digest, image };
  }
  return null;
};

/** The node-agent release: the newest `X.Y.Z` tag, no further filter. */
export const resolveNodeAgentRelease = (
  repository: string,
  fetchImpl: FetchImpl = fetch,
): Promise<NodeAgentRelease | null> => resolveAgentRelease(repository, {}, fetchImpl);

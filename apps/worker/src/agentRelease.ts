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
  manifests?: { digest?: unknown; platform?: { os?: unknown; architecture?: unknown } }[];
  config?: { digest?: unknown };
};

/**
 * The value of image label `name`, or null when the image does not carry it or
 * the registry will not say. Follows an index to its linux manifest (the
 * attestation entries a buildx push adds have no linux platform) and reads the
 * config blob.
 */
const readLabel = async (
  request: (url: string, init?: RequestInit) => Promise<Response>,
  path: string,
  authorized: Record<string, string>,
  reference: string,
  name: string,
): Promise<string | null> => {
  const getJson = async (url: string, accept?: string): Promise<unknown> => {
    const response = await request(url, {
      headers: { ...authorized, ...(accept ? { accept } : {}) },
    });
    return response.ok ? ((await response.json()) as unknown) : null;
  };
  let manifest = (await getJson(
    `${REGISTRY}/v2/${path}/manifests/${reference}`,
    MANIFEST_ACCEPT,
  )) as Manifest | null;
  const linux = manifest?.manifests?.find(
    (entry) => entry.platform?.os === "linux" && typeof entry.digest === "string",
  );
  if (linux) {
    manifest = (await getJson(
      `${REGISTRY}/v2/${path}/manifests/${String(linux.digest)}`,
      MANIFEST_ACCEPT,
    )) as Manifest | null;
  }
  const configDigest = manifest?.config?.digest;
  if (typeof configDigest !== "string") return null;
  const config = (await getJson(`${REGISTRY}/v2/${path}/blobs/${configDigest}`)) as {
    config?: { Labels?: Record<string, unknown> | null };
  } | null;
  const value = config?.config?.Labels?.[name];
  return typeof value === "string" ? value : null;
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
    if (filter.apiVersionLabel) {
      const label = await readLabel(
        request,
        path,
        authorized,
        version,
        filter.apiVersionLabel.name,
      );
      // A label that is present and unsupported rules the tag out; an absent
      // one leaves the decision to the minimum version above.
      if (label !== null && !filter.apiVersionLabel.supportedApiVersions.includes(Number(label))) {
        continue;
      }
    }

    // HEAD, not GET: the digest is a response header, and asking for the body
    // would pull a manifest list for no reason.
    const manifestResponse = await request(
      `${REGISTRY}/v2/${path}/manifests/${version}`,
      { method: "HEAD", headers: { ...authorized, accept: MANIFEST_ACCEPT } },
    );
    if (!manifestResponse.ok) return null;
    const digest = manifestResponse.headers.get(DIGEST_HEADER);
    if (!digest) return null;

    const image = `${repository.trim()}@${digest}`;
    // The same check the node will make. Resolving to something a node would
    // refuse is a bug worth catching here, where it is one log line, rather than
    // on the node, where it is a failed update on a live host.
    if (!isPublishableAgentImage(image, repository.trim())) return null;

    return { repository: repository.trim(), version, digest, image };
  }
  return null;
};

/** The node-agent release: the newest `X.Y.Z` tag, no further filter. */
export const resolveNodeAgentRelease = (
  repository: string,
  fetchImpl: FetchImpl = fetch,
): Promise<NodeAgentRelease | null> => resolveAgentRelease(repository, {}, fetchImpl);

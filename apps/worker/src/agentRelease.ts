import { isPublishableAgentImage } from "@amnezia/contracts";

/**
 * The node-agent image the panel offers nodes.
 *
 * The admin never pastes a digest and the node is never handed a tag: a tag is
 * mutable, so what gets installed could differ from what was confirmed. The
 * worker resolves the current published version to its digest here, and the
 * panel passes that exact digest through the job payload.
 */
export type NodeAgentRelease = {
  repository: string;
  version: string;
  digest: string;
  /** `repository@digest` - the only form a node accepts. */
  image: string;
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
export const pickLatestReleaseTag = (tags: string[]): string | null => {
  const releases = tags.filter((tag) => SEMVER.test(tag));
  if (releases.length === 0) return null;
  return releases.sort(compareVersions)[releases.length - 1] ?? null;
};

/** The repository path GHCR uses, e.g. `owner/repo/node-agent`. */
const registryPath = (repository: string): string | null => {
  const prefix = "ghcr.io/";
  if (!repository.startsWith(prefix)) return null;
  const path = repository.slice(prefix.length);
  return path.length > 0 ? path : null;
};

/**
 * Resolve `repository` to its newest published release and that release's
 * digest, using the registry's anonymous pull token. Returns null when the
 * package is missing, private, or the registry is unreachable - the caller must
 * degrade to "cannot resolve the current image", never to a tag.
 */
export const resolveNodeAgentRelease = async (
  repository: string,
  fetchImpl: FetchImpl = fetch,
): Promise<NodeAgentRelease | null> => {
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
  const version = pickLatestReleaseTag(tags);
  if (!version) return null;

  // HEAD, not GET: the digest is a response header, and asking for the body
  // would pull a manifest list for no reason.
  const manifestResponse = await request(
    `${REGISTRY}/v2/${path}/manifests/${version}`,
    {
      method: "HEAD",
      headers: {
        ...authorized,
        accept: [
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
          "application/vnd.docker.distribution.manifest.v2+json",
        ].join(", "),
      },
    },
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
};

// The panel telling a node "run this image" is a remote-code-execution channel
// by construction, so the reference is constrained twice: it must be a DIGEST (a
// tag is mutable, and the node's preflight refuses mutable references anyway),
// and it must live under the repository this node is configured to trust.
//
// Deliberately duplicated from packages/contracts: this service is a vendored
// fork outside the pnpm workspace and cannot import it. The host-side updater
// re-checks the same rule from the spool, because it reads a file on disk and
// has a different threat model again. All three must stay in agreement.
const AGENT_IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * True when `reference` is `<repo>@sha256:<64 hex>` for exactly `repository`.
 * Rejects a tag, a bare image id, another repository, a short or upper-case
 * digest, and anything carrying a scheme or whitespace.
 */
export const isPublishableAgentImage = (
  reference: string,
  repository: string,
): boolean => {
  if (!reference || !repository) return false;
  if (reference !== reference.trim() || /\s/.test(reference)) return false;
  if (reference.includes("://")) return false;

  const at = reference.indexOf("@");
  if (at < 0) return false;
  // No lastIndexOf: a second "@" means the reference is not what it claims.
  if (reference.indexOf("@", at + 1) >= 0) return false;

  return (
    reference.slice(0, at) === repository &&
    AGENT_IMAGE_DIGEST.test(reference.slice(at + 1))
  );
};

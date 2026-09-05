/**
 * Making a node's agent-update report fit on a card.
 *
 * The node answers with a full image reference — `repo@sha256:<64 hex>` — and a
 * message that usually quotes that same reference back. Printed as-is on a card
 * a third of a column wide, the digest wrapped across four lines, appeared
 * twice, and pushed the block past the card's edge. These helpers decide what
 * the card shows; the verbatim values stay reachable in the update log
 * disclosure, so nothing is lost by shortening them here.
 */

/** A digest cut to the twelve hex characters Docker itself shows short. */
export const shortDigest = (digest: string): string => {
  const [algorithm, hex] = digest.split(":");
  return hex ? `${algorithm}:${hex.slice(0, 12)}` : digest.slice(0, 19);
};

/**
 * An image reference split into the part that may be cut and the part that must
 * not be. A reference in any other shape than `repo@digest` is returned whole
 * rather than guessed at.
 */
export const splitImageRef = (
  image: string,
): { repo: string; digest: string | null } => {
  const at = image.lastIndexOf("@");
  return at === -1
    ? { repo: image, digest: null }
    : { repo: image.slice(0, at), digest: image.slice(at + 1) };
};

/**
 * What the node's message says beyond the image already on screen.
 *
 * Every copy of the reference — and any other bare digest, whatever its
 * wording — collapses to an ellipsis, so `already running <image>` becomes
 * `already running …` instead of repeating 70 unbreakable characters. An empty
 * result means the message carried nothing the card was not already showing,
 * and the caller renders no message line at all.
 */
export const messageBeyondImage = (
  message: string | null | undefined,
  image: string | null | undefined,
): string => {
  const text = message?.trim() ?? "";
  if (!text) return "";
  const withoutImage = image ? text.split(image).join("…") : text;
  const collapsed = withoutImage
    .replace(/\bsha256:[0-9a-f]{16,}/gi, "…")
    .replace(/…(?:\s*…)+/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  // Nothing but the elision left: the message WAS the image reference.
  return /^…$/.test(collapsed) ? "" : collapsed;
};

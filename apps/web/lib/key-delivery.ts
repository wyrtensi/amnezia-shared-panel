export type KeyDelivery = {
  /**
   * Whether the `vpn://` link is usable as a link — shown as text, copied to
   * the clipboard, encoded as a QR. False means the key exists only as a file.
   */
  linkUsable: boolean;
  /**
   * i18n key explaining why only a file works. Null when the link is usable.
   */
  reasonKey: string | null;
};

/**
 * Decide how a key of this route profile can be handed to a user.
 *
 * A split-tunnel profile inlines its whole rule set into the link, so the
 * `vpn://` payload runs from tens of thousands of characters into the
 * millions (`ru_blacklist` measured at 1 787 465). Two ceilings sit below
 * that, and both were reached in production rather than reasoned about:
 *
 *   - a QR symbol holds ~2 900 bytes at any error-correction level, which is
 *     why the QR was withdrawn for these profiles first;
 *   - the clipboard hand-off truncates it too — the copied key arrives at the
 *     client cut short, and an import of a cut key fails without saying why.
 *
 * The file downloads (`.vpn`, `.conf`) are the only shapes that survive, so
 * for these profiles the panel offers the file alone rather than three routes
 * of which two are broken.
 *
 * Extracted from the components so the rule lives in one testable place —
 * `apps/web` has no browser test runner, and the same decision is made by the
 * key card, the download dialog and the create-key wizard.
 */
export function keyDelivery(routeProfile: string): KeyDelivery {
  // Anything but the full tunnel carries a feed, and carrying a feed is what
  // makes the link too long. An unknown profile is a new feed-based one, not a
  // second full tunnel, so it defaults to the file.
  if (routeProfile === "full_tunnel") {
    return { linkUsable: true, reasonKey: null };
  }
  return { linkUsable: false, reasonKey: "config.fileOnlyWhy" };
}

/**
 * Naming a downloaded config after the connection it creates.
 *
 * The panel composes a per-key connection name (`composeKeyDisplayName`) and
 * writes it into the `vpn://` payload's `description`. Which download shapes
 * actually carry that name is decided by the AmneziaVPN client's importer, not
 * by us, and the split is sharp:
 *
 * - `vpn://` text, the camera QR and the in-app frame series all carry the same
 *   payload, so `description` reaches the client verbatim. Its Amnezia branch
 *   keeps the parsed JSON as-is and only rewrites MTU
 *   (`ImportController::processAmneziaConfig`), and the server row then renders
 *   `description` as its name (`NativeServerConfig::fromJson` falls back to the
 *   host name only when `description` is empty, which on this path it never is).
 *
 * - A plain WireGuard/AmneziaWG `.conf` CANNOT carry a name at all.
 *   `ImportController::extractWireGuardConfig` ends with
 *   `config[description] = nextAvailableServerName()`, an unconditional
 *   assignment that ignores the file entirely, so every imported `.conf` lands
 *   as "Server 1", "Server 2", ... (that literal is run through `tr()`, so a
 *   Russian client shows its own translation of it). The INI scrape skips
 *   `[section]` lines, splits everything else on the first `=`, and reads back
 *   only a fixed whitelist of WireGuard and AmneziaWG keys -- there is no
 *   `Name`, no `Description`, and no comment directive. A `# Name = ...` line
 *   would parse into the map under the key `# Name` and never be read again.
 *   Worse than useless: `checkConfigFormat` tests the Amnezia JSON markers
 *   (`containers`, `api_key`, `auth_data`) BEFORE the `[Interface]`/`[Peer]`
 *   pair, over the whole file text, so a comment that happened to contain one of
 *   those words would misroute the file to the JSON branch and fail the import.
 *   Verified against 4.8.21.0 (`client/ui/controllers/importController.cpp:533`)
 *   and today's `dev`
 *   (`client/core/controllers/selfhosted/importController.cpp:619`), plus the
 *   DefaultVPN fork, which is identical.
 *
 * The file name is not a way out either: the importer captures it
 * (`ImportUiController::extractConfigFromFile`) only to print it on the review
 * screen, and the Android/iOS "open with" route does not capture it at all.
 *
 * So the fix for "the name is lost when I import a config FILE" is to hand the
 * user the name-carrying payload AS a file, under an extension the client's own
 * picker offers: its filter is `Config files (*.vpn *.ovpn *.conf *.json)`
 * (`PageSetupWizardConfigSource.qml`), and `extractConfigFromFile` sniffs the
 * CONTENT rather than the extension -- it strips `vpn://`, base64url-decodes,
 * qUncompress-es and re-detects. A `.vpn` file holding the exact bytes this
 * panel already serves for `format=vpn` therefore imports through the same
 * "File with connection settings" flow the operator's users already know, and
 * keeps the name. That is why `vpn` downloads as `<name>.vpn` and not as the
 * `.vpn.txt` it used to be: the old suffix put the one shape that works behind a
 * filter that hides it.
 *
 * `.conf` stays on offer -- it is what awg-quick and router firmwares take, and
 * what the split-tunnel install steps recommend -- but it is now named after the
 * connection too, so a user who does import one at least knows what to rename
 * "Server 1" to.
 */

/** Longest stem we put in a file name, before the extension. */
const MAX_STEM_LENGTH = 60;

/** Fallback stem when a name folds away to nothing. */
const FALLBACK_STEM = "amnezia-key";

/**
 * Characters no mainstream file system accepts in a name. Windows is the
 * strictest of the three and its list is a superset of the others', so this is
 * what a downloaded file has to survive. `\p{Cc}` covers the control range
 * without putting raw control bytes in this source file.
 */
const FILESYSTEM_UNSAFE = /[\p{Cc}\\/:*?"<>|]+/gu;

/**
 * A file name for one key's config: the connection name the client will show,
 * plus the extension for the shape. Kept human-readable -- Cyrillic and every
 * other script survive here, and `contentDispositionAttachment` is what carries
 * them over a header safely.
 */
export const configFilename = (
  displayName: string | null,
  extension: string,
): string => {
  const stem = (displayName ?? "")
    .replace(FILESYSTEM_UNSAFE, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A leading dot would make the download a hidden file on Unix; a trailing
    // dot or space is silently dropped by Windows and changes the extension.
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, MAX_STEM_LENGTH)
    .trim();
  return `${stem || FALLBACK_STEM}.${extension}`;
};

/**
 * The ASCII half of the header. `filename=` is a quoted string of bytes, so a
 * Cyrillic name has to fold to something a byte-oriented reader can hold; the
 * extension is folded separately so it always survives, however little of the
 * stem does.
 */
const asciiFilename = (filename: string): string => {
  const lastDot = filename.lastIndexOf(".");
  const stem = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  const extension = lastDot > 0 ? filename.slice(lastDot + 1) : "";
  const foldedStem = stem
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, MAX_STEM_LENGTH);
  const foldedExtension = extension.replace(/[^A-Za-z0-9]+/g, "");
  return foldedExtension
    ? `${foldedStem || FALLBACK_STEM}.${foldedExtension}`
    : foldedStem || FALLBACK_STEM;
};

/** Percent-encoding for RFC 5987's `ext-value`, which is stricter than a URI. */
const encodeRfc5987 = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()!*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * A `content-disposition` value that keeps the connection name intact. Both
 * forms are sent per RFC 6266: `filename=` as the ASCII fallback and
 * `filename*=UTF-8''` as the real one. Without the second form a panel run in
 * Russian hands every user a file called `amnezia-key`, because the ASCII fold
 * of a Cyrillic name is empty -- which is the same "the name is lost" complaint
 * one step earlier.
 */
export const contentDispositionAttachment = (filename: string): string => {
  const ascii = asciiFilename(filename);
  const encoded = encodeRfc5987(filename);
  const header = `attachment; filename="${ascii}"`;
  // Identical forms would be noise: a plain ASCII name needs no second copy.
  return encoded === ascii ? header : `${header}; filename*=UTF-8''${encoded}`;
};

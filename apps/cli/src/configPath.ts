/**
 * Pure helpers for `key-config`, kept out of main.ts so they are unit-testable
 * (main.ts runs `main()` on import). Mirrors the config download URL the web
 * dialog builds, so the CLI pulls the exact bytes a user is shown.
 */

export const CLI_CONFIG_FORMATS = [
  "vpn",
  "conf",
  "qr",
  "qr-svg",
  "qr-frames",
] as const;

export type CliConfigFormat = (typeof CLI_CONFIG_FORMATS)[number];

/** Every format but `qr-frames`, which returns a series rather than one file. */
export type CliSingleFileFormat = Exclude<CliConfigFormat, "qr-frames">;

/** Container each single-file format returns, for the default output name. */
const FORMAT_EXTENSION: Record<CliSingleFileFormat, string> = {
  vpn: "vpn.txt",
  conf: "conf",
  qr: "png",
  "qr-svg": "svg",
};

/** Admin API path for one key's config in one format. */
export const configRequestPath = (
  keyId: string,
  format: CliConfigFormat,
  adminConfirmed: boolean,
): string =>
  `/api/keys/${encodeURIComponent(keyId)}/config?format=${format}` +
  (adminConfirmed ? "&adminConfirmed=true" : "");

/** Default file name when `--out` is omitted for a binary format. */
export const configOutputName = (
  keyId: string,
  format: CliSingleFileFormat,
): string => `${keyId}.${FORMAT_EXTENSION[format]}`;

/**
 * File name for one frame of the AmneziaVPN series. Frames are numbered from
 * one because that is how the panel labels them ("Frame 1 of 2").
 */
export const configFrameName = (base: string, index: number): string =>
  `${base}.frame-${index + 1}.svg`;

/**
 * Accept BOTH spellings deliberately. `--confirm` takes a value everywhere else
 * in this CLI (`node-remove --with-keys --confirm=<node name>`), so
 * `--confirm=true` is the shape the tool has already taught the operator. Read
 * with a bare `args.includes("--confirm")` that spelling evaluates to false, the
 * request goes out unconfirmed, and the operator gets a puzzling 403 for a
 * command they believe they confirmed.
 */
export const confirmedFromArgs = (args: string[]): boolean =>
  args.some((arg) => arg === "--confirm" || arg.startsWith("--confirm="));

/** Response headers naming the QR parameters the server chose, in print order. */
const QR_PARAM_HEADERS = [
  ["ecc", "x-qr-ecc"],
  ["modules", "x-qr-modules"],
  ["scale", "x-qr-scale"],
] as const;

/**
 * One-line summary of the QR parameters the server picked, or null when it sent
 * none. The panel chooses the error-correction level from the payload's measured
 * symbol size, and that choice is otherwise invisible — it is the first thing to
 * check against a "will not scan" report. Callers print it to stderr so stdout
 * stays a clean pipe into a file.
 */
export const formatQrParams = (headers: Headers): string | null => {
  const parts: string[] = [];
  for (const [label, header] of QR_PARAM_HEADERS) {
    const value = headers.get(header);
    if (value) parts.push(`${label}=${value}`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
};

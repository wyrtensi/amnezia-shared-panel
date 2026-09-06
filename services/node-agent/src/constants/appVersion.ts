import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The version this agent is running, read from its own package.json at startup.
 *
 * Read from the file rather than duplicated into a constant: a second copy of
 * the version is a second thing to forget on a release, and the openapi
 * contract already embeds this value, so a drift between the two is a failed
 * CI run at best and a lying `GET /server` at worst.
 *
 * The path holds in both environments because the build preserves directory
 * depth: this file is `src/constants/` in development and `dist/constants/` in
 * the image, and `package.json` sits one level above each (Dockerfile ships it
 * into the runtime stage alongside `dist/`).
 */
const packageJsonPath = join(__dirname, "..", "..", "package.json");

/**
 * Pull `version` out of a parsed package.json and confirm it is a non-empty
 * string. Exported separately from the file read so it can be exercised with
 * a fabricated object in tests, without touching the real package.json.
 */
export function extractVersion(pkg: unknown, sourcePath: string): string {
  const value = (pkg as { version?: unknown } | null)?.version;

  // Crash at startup rather than let `undefined` wear the `string` type: this
  // value is about to go on the wire via GET /server and be persisted by the
  // panel, so an agent that cannot say what it is has nothing useful to
  // report, and failing loudly at boot beats silently serving "undefined".
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${sourcePath}: "version" field is missing or not a non-empty string`,
    );
  }

  return value;
}

export const APP_VERSION: string = extractVersion(
  JSON.parse(readFileSync(packageJsonPath, "utf8")),
  packageJsonPath,
);

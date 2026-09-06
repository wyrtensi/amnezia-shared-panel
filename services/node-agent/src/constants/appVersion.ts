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

export const APP_VERSION: string = JSON.parse(
  readFileSync(packageJsonPath, "utf8"),
).version;

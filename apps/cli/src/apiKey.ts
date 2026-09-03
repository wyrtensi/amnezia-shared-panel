import { readFileSync } from "node:fs";
import { flagOf } from "./args.js";

/**
 * Human label for the flag, used in the "file is empty" error. Anything not
 * listed reads well enough as its own flag name (`token` -> "token file").
 */
const SECRET_LABELS: Record<string, string> = { "api-key": "API key" };

const defaultReadFile = (path: string): string =>
  readFileSync(path === "-" ? 0 : path, "utf8");

/**
 * Resolve a secret that the CLI accepts either inline or out-of-band.
 *
 *   --<flag>-file=<path>  read the secret from a file (first line, trimmed)
 *   --<flag>-file=-       read it from stdin
 *   --<flag>=<secret>     legacy: the secret itself; still accepted
 *
 * The file/stdin forms keep a live secret out of /proc/<pid>/cmdline, `ps`
 * and shell history, which is exactly where the inline form puts it. Undefined
 * means "not given" so a partial update can leave the stored value untouched.
 */
export const resolveSecret = (
  args: string[],
  flagName: string,
  readFile: (path: string) => string = defaultReadFile,
): string | undefined => {
  const file = flagOf(args, `${flagName}-file`);
  const inline = flagOf(args, flagName);
  if (file !== undefined && inline !== undefined) {
    throw new Error(
      `Use either --${flagName}-file= or --${flagName}=, not both`,
    );
  }
  if (file === undefined) return inline;
  const secret = readFile(file).split(/\r?\n/)[0]?.trim() ?? "";
  if (!secret) {
    const label = SECRET_LABELS[flagName] ?? flagName;
    throw new Error(
      `${label} file is empty: ${file === "-" ? "<stdin>" : file}`,
    );
  }
  return secret;
};

/** Node API key for `node-add` / `node-update`: `--api-key-file=` / `--api-key=`. */
export const resolveApiKey = (
  args: string[],
  readFile?: (path: string) => string,
): string | undefined => resolveSecret(args, "api-key", readFile);

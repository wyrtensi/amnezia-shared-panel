/** Pure argument helpers, kept out of main.ts so they are unit-testable. */

/** Value of a `--name=value` flag, or undefined. Values may contain `=`. */
export const flagOf = (args: string[], name: string): string | undefined => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split("=").slice(1).join("=") : undefined;
};

/** Positional args (everything not starting with `--`). */
export const positionals = (args: string[]): string[] =>
  args.filter((arg) => !arg.startsWith("--"));

/** Split a comma-separated value into a trimmed, non-empty list. */
export const csvList = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Parse a node-availability spec for the per-user override:
 *   "all"  -> null  (no restriction: every node)
 *   "none" -> []    (no node available)
 *   "a,b"  -> ["a","b"]
 */
export const parseNodeSpec = (spec: string): string[] | null => {
  if (spec === "all") return null;
  if (spec === "none") return [];
  return csvList(spec);
};

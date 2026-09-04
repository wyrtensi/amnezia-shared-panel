/**
 * Shared "at least N" integer env parser for the periodic-task knobs read
 * directly in `main.ts` (not the ones covered by `config.ts`'s own copy —
 * see `resolveWorkerPeriods`). Split into its own module purely so it can be
 * unit-tested: `main.ts` opens a database connection and reads required env
 * vars at import time, so importing it directly in a test would need a real
 * Postgres instance.
 */

// Shared by the two variants below: `min` and `invalidMessage` are the only
// ways they differ (whether 0 is allowed, and the wording of the error). A
// raw value that trims to empty (unset, or a blank ".env" line) falls back
// to the default instead of reaching `Number()` — `Number(" ")` is `0`, which
// is a legal "no cap" value for the non-negative variant, so without the trim
// an operator's whitespace-only override would silently disable a cap instead
// of falling back to it.
export const integerEnvAtLeast = (
  name: string,
  fallback: number,
  min: number,
  invalidMessage: string,
): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(invalidMessage);
  }
  return value;
};

export const positiveIntegerEnv = (name: string, fallback: number): number =>
  integerEnvAtLeast(name, fallback, 1, `${name} must be a positive integer`);

export const nonNegativeIntegerEnv = (name: string, fallback: number): number =>
  integerEnvAtLeast(name, fallback, 0, `${name} must be a non-negative integer`);

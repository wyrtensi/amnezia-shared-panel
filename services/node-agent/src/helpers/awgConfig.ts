import { AppContract } from "@/contracts/app";
import { AwgParams, AwgVersion } from "@/types/amnezia";

// Base obfuscation parameters shared by every AmneziaWG version
const BASE_KEYS: readonly string[] = ["Jc", "Jmin", "Jmax", "S1", "S2"];

// Magic packet headers
const MAGIC_HEADER_KEYS: readonly string[] = ["H1", "H2", "H3", "H4"];

// Junk sizes introduced in AmneziaWG 2.0
const AWG2_KEYS: readonly string[] = ["S3", "S4"];

// Special junk packets introduced in AmneziaWG 1.5
export const AWG_SPECIAL_JUNK_KEYS: readonly string[] = [
  "I1",
  "I2",
  "I3",
  "I4",
  "I5",
];

// Parameters introduced in AmneziaWG 3.1
export const AWG3_KEYS: readonly string[] = [
  "HeaderProtectionKey",
  "ContentPaddingAddition",
  "RekeyAfterTime",
  "RekeyTimeout",
  "RejectAfterTime",
  "KeepaliveTimeout",
  "MaxHandshakeAttempts",
];

// Toggles introduced in AmneziaWG 3.1
export const AWG3_TOGGLE_KEYS: readonly string[] = [
  "RandomTrailers",
  "DisableCookies",
];

/**
 * Read an active parameter value from a server configuration.
 */
const readActiveParam = (config: string, key: string): string =>
  config.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, "mi"))?.[1] || "";

/**
 * Read a commented-out parameter value from a server configuration.
 */
const readCommentedParam = (config: string, key: string): string =>
  config
    .match(new RegExp(`^\\s*#\\s*${key}\\s*=\\s*(.*?)\\s*$`, "mi"))?.[1]
    ?.trim() || "";

/**
 * Check that a special junk value is safe to embed into a client config.
 */
const isValidSpecialJunk = (value: string): boolean =>
  Boolean(value) && !value.includes("#") && !value.includes("[Peer]");

/**
 * Check whether an AmneziaWG 3.1 toggle is enabled, the way `awg` itself reads
 * one.
 *
 * `parse_bool` in amneziawg-tools accepts `on`/`off` case-insensitively AND a
 * decimal number, taking the value as `ret != 0`. So `DisableCookies = 0` is a
 * legal way to write "off", and reading it as "on" - which a plain
 * "anything that is not the word off" test does - reports a node as running a
 * feature the daemon has switched off.
 *
 * `awg` exits on a value that is neither form. Here we are only reading a
 * config, so an unparseable value is treated as disabled: it must never be
 * allowed to read as enabled.
 */
export const isAwgToggleEnabled = (value: string): boolean => {
  const trimmed = value.trim().toLowerCase();

  if (!trimmed) return false;
  if (trimmed === AppContract.WG.TOGGLE_OFF) return false;
  if (trimmed === AppContract.WG.TOGGLE_ON) return true;
  if (!/^\d+$/.test(trimmed)) return false;

  return Number(trimmed) !== 0;
};

/**
 * Read an AmneziaWG parameter from a server configuration
 * (active value first, then a commented-out fallback).
 */
export const readAwgParam = (config: string, key: string): string =>
  readActiveParam(config, key) || readCommentedParam(config, key);

/**
 * Parse the AmneziaWG obfuscation parameters from a server configuration.
 */
export const parseAwgParams = (config: string): AwgParams => {
  const params: AwgParams = {};

  for (const key of [...BASE_KEYS, ...AWG2_KEYS, ...MAGIC_HEADER_KEYS]) {
    params[key] = readAwgParam(config, key);
  }

  for (const key of AWG_SPECIAL_JUNK_KEYS) {
    const value = readAwgParam(config, key);

    // I2-I5 may contain leftover config markup; such values are not carried over
    params[key] = key === "I1" || isValidSpecialJunk(value) ? value : "";
  }

  // 3.1 parameters decide the protocol version, so commented values are ignored
  for (const key of AWG3_KEYS) {
    params[key] = readActiveParam(config, key);
  }

  for (const key of AWG3_TOGGLE_KEYS) {
    const value = readActiveParam(config, key);

    params[key] = isAwgToggleEnabled(value) ? value : "";
  }

  return params;
};

/**
 * Determine the AmneziaWG protocol version from a set of parameters.
 */
export const resolveAwgVersion = (params: AwgParams): AwgVersion | null => {
  const hasValue = (key: string) => Boolean(params[key]?.trim());

  // 3.1: header protection, timing randomization and trailers
  if (AWG3_KEYS.some(hasValue) || AWG3_TOGGLE_KEYS.some(hasValue)) {
    return AwgVersion.V3_1;
  }

  // 2.0: junk sizes S3/S4 and ranged magic headers
  if (
    AWG2_KEYS.some(hasValue) ||
    MAGIC_HEADER_KEYS.some((key) => params[key]?.includes("-"))
  ) {
    return AwgVersion.V2;
  }

  // 1.5: special junk packets I1-I5
  if (AWG_SPECIAL_JUNK_KEYS.some(hasValue)) {
    return AwgVersion.V1_5;
  }

  return null;
};

/**
 * Remove configuration lines whose value is empty.
 */
export const dropEmptyConfigLines = (config: string): string =>
  config
    .split("\n")
    .filter((line) => !/^\s*\S+\s*=\s*$/.test(line))
    .join("\n");

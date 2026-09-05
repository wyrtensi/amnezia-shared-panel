/**
 * Structural copy of `deviceSupportsRouteProfiles` from @amnezia/contracts.
 *
 * The CLI declares no runtime dependencies on purpose (see the plan's D7), so
 * it re-states small facts rather than importing the workspace package — the
 * same trade-off `main.ts` already makes for `AdminUser` and `GlobalRoutes`,
 * and `args.ts` for `DEVICE_TYPES`. Both copies are pinned by a test; if the
 * contract list changes, this one and its test change with it.
 *
 * The value names a platform: "ios" covers iPhone and iPad alike.
 *
 * Operator-verified 2026-09-02 / 2026-09-03: on an iPhone a key with a route
 * profile connects but applies no rules, with both the vpn:// key and an
 * imported .conf. The client observed was Default VPN — the listing the Russian
 * App Store offers, because AmneziaVPN itself is hidden from it. AmneziaVPN on
 * iOS is a different app and was NOT observed, so it is not claimed to fail.
 * This list stays because Default VPN is what most iOS users end up with.
 *
 * Since #67 it gates nothing in the panel — the wizard offers every profile on
 * every platform and lets the client sort it out — so on this side it is only
 * what the CLI's two warnings are phrased against, never a refusal.
 * Stop-gap, not a permanent design decision — see T2-a.
 */
const ROUTE_PROFILE_UNSUPPORTED_DEVICES = ["ios"];

export function cliDeviceSupportsRouteProfiles(deviceType: string): boolean {
  return !ROUTE_PROFILE_UNSUPPORTED_DEVICES.includes(deviceType);
}

/**
 * The line `user-create-key` prints when the operator asks for a combination
 * that will not filter anything on the target device. Returns null when there
 * is nothing to say.
 *
 * A warning, never a refusal: the panel does not enforce this (the key works
 * fine if the user opens it on a laptop), and an operator creating a key on
 * someone's behalf may know better than the label does.
 */
export function routeProfileWarning(
  deviceType: string | undefined,
  routeProfile: string | undefined,
): string | null {
  if (!deviceType || cliDeviceSupportsRouteProfiles(deviceType)) return null;
  const profile = routeProfile ?? "full_tunnel";
  if (profile === "full_tunnel") return null;
  return `warning: device-type "${deviceType}" usually means the Default VPN app, which connects but applies no route profile — a key with "${profile}" will send all traffic outside the VPN. Use --route=full_tunnel unless the user runs AmneziaVPN itself. Creating it anyway.`;
}

/**
 * Does an existing key pair a gated platform with a split-tunnel profile?
 *
 * Nothing in the panel stops that pair being made or says anything about it:
 * since #67 the create-key wizard offers every profile on every platform and
 * the key card's warning is gone. `keys --needs-profile-warning` exists to
 * count them on a live panel, and it and `user-create-key`'s warning below
 * are the only two places the combination is visible at all.
 *
 * Both fields must be present: a key whose platform was never recorded is not
 * evidence of anything, and guessing would inflate the count.
 */
export function keyNeedsRouteProfileWarning(key: {
  deviceType?: string;
  routeProfile?: string;
}): boolean {
  const { deviceType, routeProfile } = key;
  if (!deviceType || !routeProfile) return false;
  if (cliDeviceSupportsRouteProfiles(deviceType)) return false;
  return routeProfile !== "full_tunnel";
}

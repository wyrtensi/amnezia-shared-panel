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
 * imported .conf. Stop-gap, not a permanent design decision — see T2-a.
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
  return `warning: device-type "${deviceType}" does not apply route profiles — a key with "${profile}" will connect but send all traffic outside the VPN. Use --route=full_tunnel for this device. Creating it anyway.`;
}

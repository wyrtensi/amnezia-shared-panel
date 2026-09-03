import { deviceSupportsRouteProfiles } from "@amnezia/contracts";

export type RouteProfileChoice = {
  /** Whether the wizard renders this profile's card as greyed out. */
  disabled: boolean;
  /**
   * i18n key explaining WHY, rendered by OptionCards both as the native
   * `title` (hover) and as visible text inside the card (touch, and everyone
   * else). Null when the card is selectable.
   */
  hintKey: string | null;
};

/**
 * Decide whether one route-profile card in the create-key wizard is
 * selectable, and if not, which explanation to show.
 *
 * Extracted from the wizard so the rule can be unit-tested without a DOM:
 * `apps/web` has no browser test runner, and screenshot testing is out of
 * scope. The wizard is a caller, not the place the rule lives.
 *
 * `full_tunnel` is never disabled here — it is the fallback every other branch
 * steers towards, and a panel that could disable it could create no keys.
 */
export function routeProfileChoice({
  profile,
  rulesReady,
  policyLocked,
  deviceType,
  hasAmneziaClient = false,
}: {
  profile: string;
  /** The profile's rule set has been built and is active on the node. */
  rulesReady: boolean;
  /** The admin policy forbids choosing anything but the full tunnel. */
  policyLocked: boolean;
  /** What the user just told us this key is for. */
  deviceType: string;
  /**
   * The user asserts they run AmneziaVPN itself rather than Default VPN. Only
   * ever true for a device type that would otherwise be blocked, and it is an
   * assertion, not a detection: the panel cannot see which app is installed.
   */
  hasAmneziaClient?: boolean;
}): RouteProfileChoice {
  if (profile === "full_tunnel") return { disabled: false, hintKey: null };


  // Ordered by what the user can do about it. The device type is the only one
  // of the three they can change themselves, so it wins the message when
  // several reasons apply; the other two are for an administrator to fix.
  // The block is about the app, not the hardware: profiles were observed to
  // connect and apply nothing in Default VPN, which is the listing the Russian
  // App Store offers. A user on AmneziaVPN itself can say so and have it lifted
  // -- the panel has no way to detect the client, so the user's word is the
  // only signal there is, and it is better than refusing them outright.
  if (!hasAmneziaClient && !deviceSupportsRouteProfiles(deviceType)) {
    return { disabled: true, hintKey: "wizard.profileNoIphone" };
  }
  if (!rulesReady) {
    return { disabled: true, hintKey: "wizard.rulesNotActive" };
  }
  if (policyLocked) {
    return { disabled: true, hintKey: "wizard.profileDisabled" };
  }
  return { disabled: false, hintKey: null };
}

import type { KeyView, Me } from "@/lib/types";

/**
 * How many of a user's keys are followed by the "install or update the app"
 * step.
 *
 * One. The dialog says the same thing every time, so a second showing adds
 * nothing for the person who read it and only irritates the person who did
 * not — the two-round checkbox inside it is what answers the second kind,
 * not repetition. It is a count of keys **ever created**, not of keys
 * currently held — see `keyNumberOf`.
 */
export const INSTALL_REMINDER_KEYS = 1;

/**
 * The key's per-owner ordinal, or null when the payload does not carry one.
 *
 * `keyNumber` is assigned by the control API at creation as
 * `max(keyNumber for this owner) + 1`, and revoking a key leaves its row (and
 * therefore its number) in place. So it counts what the user has ever created,
 * which is the honest reading of "their first key": counting the keys they
 * hold today would show the dialog again to anyone who revokes one and makes
 * a replacement. The one thing that can lower it is an administrator **purging** a key row
 * outright, which is rare, deliberate, and not something to model around.
 *
 * Null for rows created before the column existed (pre-migration keys, which by
 * definition belong to users who are long past their first key) — those get
 * no reminder rather than a guessed number.
 */
export const keyNumberOf = (key: KeyView | undefined): number | null =>
  typeof key?.keyNumber === "number" && Number.isFinite(key.keyNumber)
    ? key.keyNumber
    : null;

/**
 * Whether the user who just created `keyNumber` should be shown the install
 * step before anything else.
 *
 * Three conditions, all of which have to hold:
 *
 * - the policy has not switched it off (`showInstallReminder`, default true);
 * - the viewer is not an administrator — an admin makes keys all day and does
 *   not need telling what the client is;
 * - this is one of their first `INSTALL_REMINDER_KEYS` keys ever.
 *
 * The policy value is read as `!== false` rather than as a truthy test: a panel
 * whose control API predates the field sends no value at all, and the reminder
 * defaulting ON there matches what the contract says the default is.
 */
export function shouldShowInstallReminder({
  me,
  keyNumber,
}: {
  me: Pick<Me, "role" | "policy"> | null;
  keyNumber: number | null;
}): boolean {
  if (!me) return false;
  if (me.role === "admin") return false;
  if (me.policy?.showInstallReminder === false) return false;
  if (keyNumber === null) return false;
  return keyNumber >= 1 && keyNumber <= INSTALL_REMINDER_KEYS;
}

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
 * NOTE: this is now the FALLBACK, not the rule. `me.notices.install` is a count
 * of what the user was actually shown and it answers the question outright; the
 * ordinal below is only consulted when the control API is older than that
 * counter. The reason for the demotion is in the paragraph after next: the
 * ordinal can go DOWN, and a bulk "purge revoked keys" makes it go down often.
 *
 * `keyNumber` is assigned by the control API at creation as
 * `max(keyNumber for this owner) + 1`, and revoking a key leaves its row (and
 * therefore its number) in place. So it counts what the user has ever created,
 * which is the honest reading of "their first key": counting the keys they
 * hold today would show the dialog again to anyone who revokes one and makes
 * a replacement.
 *
 * Null for rows created before the column existed (pre-migration keys, which by
 * definition belong to users who are long past their first key) — those get
 * no reminder rather than a guessed number.
 *
 * What it cannot survive is an administrator **purging** a key row outright,
 * which lowers the max. That was once written off here as rare and deliberate,
 * and then the admin panel grew a one-click "purge every revoked key" sweep:
 * an ordinary cleanup started handing somebody on their fortieth key the
 * first-key warning again. `users.install_notice_acks` exists to end that, and
 * this ordinal is now only the fallback for a panel too old to send it.
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
  me: Pick<Me, "role" | "policy" | "notices"> | null;
  keyNumber: number | null;
}): boolean {
  if (!me) return false;
  if (me.role === "admin") return false;
  if (me.policy?.showInstallReminder === false) return false;
  // Both, ANDed, whenever both are available — each one only ever ENDS the
  // reminder sooner, and they end it for different reasons.
  //
  // The counter alone would nag forever: it is incremented when the dialog is
  // read through to the end, and the ✕ and Esc deliberately still close it, so
  // somebody who dismisses their first one would sit at zero and be stopped on
  // every key they ever make. The ordinal alone is the bug this counter exists
  // to fix — it falls when an administrator purges that owner's rows, and says
  // "first key" about somebody on their fortieth.
  //
  // So: the ordinal still says when they are past their first keys, and the
  // counter still says when they have already answered.
  const signed = me.notices?.install;
  if (typeof signed === "number" && Number.isFinite(signed)) {
    if (signed >= INSTALL_REMINDER_KEYS) return false;
    // A payload with a counter but no ordinal (a pre-migration key row) has
    // nothing left to disqualify it, so the counter decides on its own.
    if (keyNumber === null) return true;
  } else if (keyNumber === null) {
    return false;
  }
  return keyNumber >= 1 && keyNumber <= INSTALL_REMINDER_KEYS;
}

import { UPDATE_NOTICE_SHOWINGS } from "@amnezia/contracts";
import type { Me } from "@/lib/types";

export { UPDATE_NOTICE_SHOWINGS };

/**
 * Whether the person reaching for a key should be stopped and shown the update
 * notice first.
 *
 * Four conditions, all of which have to hold:
 *
 * - the policy has not switched it off (`showUpdateNotice`, default true);
 * - the viewer is not an administrator — an admin hands out keys all day, and
 *   the same exclusion the install reminder makes for the same reason;
 * - the profile has loaded at all;
 * - they have signed it fewer than `UPDATE_NOTICE_SHOWINGS` times.
 *
 * The policy value is read as `!== false` rather than as a truthy test: a panel
 * whose control API predates the field sends no value, and the reminder
 * defaulting ON there matches what the contract says the default is. The count
 * is read the other way round — a missing count means zero, so a payload with
 * no counters shows the notice rather than silently swallowing it.
 */
export function shouldShowUpdateNotice({
  me,
}: {
  me: Pick<Me, "role" | "policy" | "notices"> | null;
}): boolean {
  if (!me) return false;
  if (me.role === "admin") return false;
  if (me.policy?.showUpdateNotice === false) return false;
  return updateNoticeAcksOf(me) < UPDATE_NOTICE_SHOWINGS;
}

/** The signed count, reading anything missing or nonsensical as zero. */
export function updateNoticeAcksOf(
  me: Pick<Me, "notices"> | null | undefined,
): number {
  const value = me?.notices?.update;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * Wraps one reach for a key — a QR, a clipboard write, a config download —
 * so the notice can come first.
 *
 * It takes the ACTION rather than decorating the button: the same four routes
 * to a key appear on the card, inside the config dialog, and in different
 * combinations per route profile, and a guard around the action is the only
 * shape that covers all of them without being remembered at each call site.
 *
 * `action` must be safe to call synchronously inside a click handler — that is
 * how the clipboard and the download keep their user activation.
 */
export type KeyAccessGuard = (action: () => void) => void;

/** One point of a signature stroke, in CSS pixels within the pad. */
export type SignaturePoint = { x: number; y: number };
/** One uninterrupted press-move-release. A signature is a list of them. */
export type SignatureStroke = SignaturePoint[];

/**
 * How much ink the pad has to hold before the confirm button wakes up, in CSS
 * pixels of travel.
 *
 * A threshold rather than "a pointer went down" because a stray touch is the
 * normal failure here: the pad sits inside a scrollable dialog on a phone, and
 * a finger that brushes it while scrolling must not arm a button that hands
 * over a key. 160px is roughly half the pad's width on the narrowest screen the
 * panel supports — a scribble clears it without trying, a dot never does.
 */
export const SIGNATURE_MIN_LENGTH = 160;

/** Total distance travelled across every stroke, in CSS pixels. */
export function signatureLength(strokes: SignatureStroke[]): number {
  let total = 0;
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.length; i += 1) {
      const from = stroke[i - 1];
      const to = stroke[i];
      if (!from || !to) continue;
      total += Math.hypot(to.x - from.x, to.y - from.y);
    }
  }
  return total;
}

/** Whether what is on the pad counts as a signature rather than as a smudge. */
export function signatureIsEnough(
  strokes: SignatureStroke[],
  minLength: number = SIGNATURE_MIN_LENGTH,
): boolean {
  return signatureLength(strokes) >= minLength;
}

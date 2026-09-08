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
  signedAt = null,
  now = Date.now(),
}: {
  me: Pick<Me, "role" | "policy" | "notices"> | null;
  /** When this browser last saw a signature, or null if it has not. */
  signedAt?: number | null;
  now?: number;
}): boolean {
  if (!me) return false;
  if (me.role === "admin") return false;
  if (me.policy?.showUpdateNotice === false) return false;
  if (inUpdateNoticeGrace(signedAt, now)) return false;
  return updateNoticeAcksOf(me) < UPDATE_NOTICE_SHOWINGS;
}

/**
 * How long the notice stays out of the way after somebody signs it.
 *
 * The two showings are meant to land on two separate occasions, and without
 * this they land on two consecutive clicks: sign for the QR, close it, reach
 * for the `.conf` file, and the same poster is back — which teaches people to
 * scribble through it rather than to read it. Half an hour is long enough to
 * cover one sitting with a key and short enough that the second showing still
 * happens the same day.
 */
export const UPDATE_NOTICE_GRACE_MS = 30 * 60 * 1000;

/** Whether a signature is recent enough that the notice should stay down. */
export function inUpdateNoticeGrace(
  signedAt: number | null,
  now: number,
): boolean {
  if (signedAt === null || !Number.isFinite(signedAt)) return false;
  const since = now - signedAt;
  // A negative age is a clock that moved (or a stored value from the future);
  // treat it as no grace rather than as an unbounded one.
  return since >= 0 && since < UPDATE_NOTICE_GRACE_MS;
}

/**
 * How long the sheet stays on screen after the signature, showing the stamp.
 *
 * Lives here rather than in the dialog because it is not only the dialog's
 * business: the action it releases paints its own confirmation on the card
 * UNDERNEATH the sheet, so that confirmation has to outlast this or the user
 * watches the poster leave and finds nothing where their click went.
 */
export const UPDATE_NOTICE_STAMP_MS = 1080;

/**
 * Where the quiet period is remembered, and why it is not the server.
 *
 * The COUNT is the server's business — it decides whether this person is owed
 * a showing at all, and it must survive a new device and a cleared browser.
 * The quiet period is the opposite kind of fact: it exists so the two showings
 * do not land on two consecutive clicks in one sitting, which is a property of
 * this browser in this half hour. Losing it costs one extra poster; giving it a
 * column and a round trip would cost more than that.
 *
 * Every access is wrapped: a private window, a browser set to block site data
 * and a thumbnailer all throw on the accessor itself, and none of them is a
 * reason for a key to stop being handed over.
 */
const SIGNED_AT_KEY = "amnezia-notice-signed-at";

/** Fallback for a browser that refuses storage — same tab, same session. */
let signedAtInMemory: number | null = null;

/** When this browser last saw a signature, or null. */
export function readNoticeSignedAt(): number | null {
  try {
    const raw = window.localStorage.getItem(SIGNED_AT_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  } catch {
    // Storage is unavailable; the in-memory value is the whole answer.
  }
  return signedAtInMemory;
}

/** Start the quiet period. */
export function rememberNoticeSignedAt(now: number = Date.now()): void {
  signedAtInMemory = now;
  try {
    window.localStorage.setItem(SIGNED_AT_KEY, String(now));
  } catch {
    // Nothing to do and nothing to report: the in-memory value still holds for
    // this tab, which is the case the quiet period exists for.
  }
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
 *
 * It is told whether it was `deferred`, i.e. whether a notice stood in front of
 * it. An action that paints a confirmation on the card needs to know: the sheet
 * covers that card for `UPDATE_NOTICE_STAMP_MS` after the action has already
 * run, so a confirmation timed from the click alone is half over by the time
 * anyone can see it.
 */
export type KeyAccessGuard = (action: (deferred: boolean) => void) => void;

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

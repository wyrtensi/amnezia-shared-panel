import { GUIDE_AUDIENCES, type GuideAudience } from "@amnezia/contracts";

/**
 * Deep links into the user panel's two help dialogs.
 *
 * Support answers a question with a link, not with "log in and find the
 * button": `?help=install&os=android` opens the connect guide already on the
 * Android instruction, `?help=key` opens the "how do I create a key" dialog.
 *
 * A query parameter rather than a route or a hash: the panel is one page, the
 * dialogs are page state and not places of their own, and a query string is
 * what survives being pasted into a chat window and retyped by hand at the
 * other end. Which is also why nothing here throws — see `readHelpLink`.
 */

/** Names the dialog to open. */
export const HELP_PARAM = "help";
/** Pre-selects the install guide's device group. Ignored by the other dialog. */
export const OS_PARAM = "os";

/**
 * The dialogs a link may name. Short words an operator can type from memory —
 * `install` is the connect guide ("Как подключиться"), `key` is the create-key
 * explanation — rather than the component names they happen to be built from.
 */
export const HELP_DIALOGS = ["install", "key"] as const;
export type HelpDialog = (typeof HELP_DIALOGS)[number];

export type HelpLink = {
  dialog: HelpDialog;
  /**
   * Device group the install guide opens on, or null to leave its chooser
   * empty. The values are the chooser's own groups (`desktop`, `android`,
   * `ios`) and come straight from the contract, so a group added there is
   * linkable the same day.
   */
  audience: GuideAudience | null;
};

/** A hand-retyped link may carry spaces and capitals; neither is an error. */
const normalise = (raw: string | null): string => (raw ?? "").trim().toLowerCase();

const asParams = (search: string | URLSearchParams): URLSearchParams =>
  typeof search === "string" ? new URLSearchParams(search) : search;

/**
 * What a query string asks the panel to open, or null for "nothing".
 *
 * Every unknown value fails soft, because the failure mode of a link is
 * somebody retyping it: an unknown dialog name is treated as no link at all,
 * and an unknown, empty or misspelled `os` opens the guide on its chooser
 * rather than on a wrong instruction. Nothing here can throw, so no link can
 * ever produce an error page.
 */
export function readHelpLink(search: string | URLSearchParams): HelpLink | null {
  const params = asParams(search);
  const dialog = HELP_DIALOGS.find(
    (value) => value === normalise(params.get(HELP_PARAM)),
  );
  if (!dialog) return null;
  // Only the guide has a chooser. Reading `os` for the other dialog would let a
  // link carry a group nothing can display, and the writer would then put it
  // straight back into the bar.
  if (dialog !== "install") return { dialog, audience: null };
  const os = normalise(params.get(OS_PARAM));
  return {
    dialog,
    audience: GUIDE_AUDIENCES.find((value) => value === os) ?? null,
  };
}

/**
 * The query string the address bar should carry for `link`, keeping whatever
 * else was already on the URL. `null` clears both parameters — that is a closed
 * dialog. Returns "" when nothing is left, so the caller can write a bare path.
 *
 * `os` is written only for the guide, and only once a group is chosen: a link
 * to the chooser is `?help=install`, and copying `?help=install&os=` back out
 * of the bar would teach an operator a value that means nothing.
 */
export function helpLinkSearch(
  current: string | URLSearchParams,
  link: HelpLink | null,
): string {
  const params = new URLSearchParams(asParams(current).toString());
  params.delete(HELP_PARAM);
  params.delete(OS_PARAM);
  if (link) {
    params.set(HELP_PARAM, link.dialog);
    if (link.dialog === "install" && link.audience) {
      params.set(OS_PARAM, link.audience);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * States a key's owner must never see: they asked for the key to be gone.
 *
 * `revoking` is the whole of "being deleted", including an attempt that failed
 * -- the worker records the reason on the key and leaves the state alone, so a
 * node that was down does not resurrect a deleted key in the owner's list.
 * `failed` is deliberately absent: it now means only that provisioning never
 * completed, which is an error the owner is entitled to see and act on.
 *
 * The full state model is `docs/KEY-STATES.md`. Admin views are exempt -- an
 * operator debugging a stuck delete needs every state verbatim.
 */
export const HIDDEN_KEY_STATES = ["revoking", "revoked"] as const;

/**
 * Whether a key in this state belongs in its owner's list.
 *
 * Takes a `string`, not `KeyState`: `KeyView.state` is what the API sent, and a
 * state this build has never heard of must be decided rather than crash. An
 * unknown state is shown, which is the safe direction -- a key the owner still
 * has must never silently vanish from their list.
 */
export const isVisibleToOwner = (state: string): boolean =>
  !(HIDDEN_KEY_STATES as readonly string[]).includes(state);

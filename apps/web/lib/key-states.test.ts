import { keyStateSchema } from "@amnezia/contracts";
import { describe, expect, it } from "vitest";

import {
  HIDDEN_KEY_STATES,
  isVisibleToOwner,
  markRulesDelivered,
} from "./key-states";

describe("isVisibleToOwner", () => {
  it("hides a key the owner asked to be gone", () => {
    // `revoking` covers a revoke still in flight AND one whose last attempt
    // failed: the worker records the reason and leaves the state alone rather
    // than moving the key to `failed`, which used to hand the owner back a key
    // they had just deleted, labelled "Error".
    expect(isVisibleToOwner("revoking")).toBe(false);
    expect(isVisibleToOwner("revoked")).toBe(false);
  });

  it("shows a key whose provisioning failed, so the owner sees the error", () => {
    expect(isVisibleToOwner("failed")).toBe(true);
  });

  it("shows every state a working key passes through", () => {
    expect(isVisibleToOwner("provisioning")).toBe(true);
    expect(isVisibleToOwner("active")).toBe(true);
    expect(isVisibleToOwner("disabled")).toBe(true);
  });

  it("decides every state the contract can send", () => {
    // A seventh state added to the contract without a decision here would show
    // up in a user's list by accident. Read from the contract, not restated:
    // this is the assertion that catches the drift.
    const hidden = keyStateSchema.options.filter(
      (state) => !isVisibleToOwner(state),
    );
    expect(hidden).toEqual([...HIDDEN_KEY_STATES]);
  });
});

describe("markRulesDelivered", () => {
  const keys = [
    { id: "a", rulesOutdated: true },
    { id: "b", rulesOutdated: true },
  ];

  it("clears the flag on the delivered key only", () => {
    expect(markRulesDelivered(keys, "a")).toEqual([
      { id: "a", rulesOutdated: false },
      { id: "b", rulesOutdated: true },
    ]);
  });

  it("hands back the same array when there is nothing to clear", () => {
    const current = [{ id: "a", rulesOutdated: false }];
    expect(markRulesDelivered(current, "a")).toBe(current);
    expect(markRulesDelivered(keys, "missing")).toBe(keys);
  });
});

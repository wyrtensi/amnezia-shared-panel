import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MIN_AWG3_CLIENT_VERSION } from "@amnezia/contracts";

import { InstallReminderBody } from "./install-reminder-dialog";

/**
 * Rendered for real, not asserted against a restated copy of the rule.
 *
 * `InstallReminderBody` is the dialog minus its Radix frame precisely so this
 * is possible: a portal renders nothing outside a browser, and this repo's
 * vitest runs on `environment: "node"` with no DOM. Static markup answers the
 * question that matters — is the button actually disabled, or only styled that
 * way.
 */
const render = (acknowledged: boolean) =>
  renderToStaticMarkup(
    <InstallReminderBody
      acknowledged={acknowledged}
      onAcknowledgedChange={() => undefined}
      onLater={() => undefined}
      onContinue={() => undefined}
    />,
  );

/**
 * The one `<button>` carrying this label. Matched on the whole element and
 * asserted to be unique, so a second button with the same word makes the test
 * fail rather than silently pick one.
 */
const buttonWith = (html: string, label: string): string => {
  const found = (html.match(/<button[^>]*>.*?<\/button>/g) ?? []).filter(
    (button) => button.includes(`>${label}<`),
  );
  expect(found, `expected exactly one button labelled ${label}`).toHaveLength(1);
  return found[0]!;
};

/**
 * React renders a disabled control as the bare `disabled=""` attribute. The
 * word also appears inside the button's class list (`disabled:opacity-50`), so
 * the attribute has to be matched, not the substring — testing for "disabled"
 * alone would pass on every button forever.
 */
const isDisabled = (element: string): boolean => / disabled=""/.test(element);

const checkbox = (html: string): string => {
  const found = html.match(/<input[^>]*type="checkbox"[^>]*>/);
  expect(found, "expected a checkbox in the dialog body").not.toBeNull();
  return found![0];
};

describe("InstallReminderBody", () => {
  it("keeps Далее genuinely disabled until the box is ticked", () => {
    expect(isDisabled(buttonWith(render(false), "Далее"))).toBe(true);
  });

  it("enables Далее once it is", () => {
    expect(isDisabled(buttonWith(render(true), "Далее"))).toBe(false);
  });

  it("gates the button on a checkbox that is really checked", () => {
    expect(checkbox(render(true))).toMatch(/ checked=""/);
    expect(checkbox(render(false))).not.toMatch(/ checked=""/);
  });

  it("asks the browser not to remember the tick", () => {
    // Without this, Chrome restores the box as ticked after a reload of the
    // same URL and the next key's dialog opens with its Next already live —
    // the one thing the gate exists to prevent. Observed, then fixed; asserted
    // here so a tidy-up cannot quietly drop the attribute again.
    expect(checkbox(render(false))).toMatch(/ autocomplete="off"/i);
  });

  it("always offers a way out, ticked or not", () => {
    // Closable on purpose: the dialog comes back on the next key while the
    // user is still inside their first few, so it does not need to trap them.
    for (const acknowledged of [false, true]) {
      expect(
        isDisabled(buttonWith(render(acknowledged), "Позже")),
        String(acknowledged),
      ).toBe(false);
    }
  });

  it("names the client version the key actually needs", () => {
    // The whole reason the step is mandatory. Interpolated from the contract,
    // never typed into the copy — see the messages test.
    expect(render(false)).toContain(MIN_AWG3_CLIENT_VERSION);
  });
});

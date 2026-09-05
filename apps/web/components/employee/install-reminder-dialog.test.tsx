import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MIN_AWG3_CLIENT_VERSION } from "@amnezia/contracts";

import {
  InstallReminderBody,
  INSTALL_REMINDER_START,
  installReminderStep,
  type InstallReminderEvent,
  type InstallReminderStep,
} from "./install-reminder-dialog";

/**
 * Rendered for real, not asserted against a restated copy of the rule.
 *
 * `InstallReminderBody` is the dialog minus its Radix frame precisely so this
 * is possible: a portal renders nothing outside a browser, and this repo's
 * vitest runs on `environment: "node"` with no DOM. Static markup answers the
 * question that matters — is the button actually disabled, or only styled that
 * way.
 */
const render = (step: InstallReminderStep) =>
  renderToStaticMarkup(
    <InstallReminderBody
      acknowledged={step.acknowledged}
      challenged={step.challenged}
      onAcknowledgedChange={() => undefined}
      onSubmit={() => undefined}
    />,
  );

/** The four cells of the state machine, named the way the operator names them. */
const ROUND_ONE_UNTICKED: InstallReminderStep = INSTALL_REMINDER_START;
const ROUND_ONE_TICKED: InstallReminderStep = {
  acknowledged: true,
  challenged: false,
};
const ROUND_TWO_UNTICKED: InstallReminderStep = {
  acknowledged: false,
  challenged: true,
};
const ROUND_TWO_TICKED: InstallReminderStep = {
  acknowledged: true,
  challenged: true,
};

/** The one and only `<button>` in the body, whatever it currently says. */
const theButton = (html: string): string => {
  const found = html.match(/<button[^>]*>.*?<\/button>/g) ?? [];
  expect(found, "the dialog body has exactly one button").toHaveLength(1);
  return found[0]!;
};

const labelOf = (button: string): string =>
  button.replace(/^<button[^>]*>/, "").replace(/<\/button>$/, "");

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
  it("opens on «Далее», disabled, next to «Я прочитал, действуем»", () => {
    const html = render(ROUND_ONE_UNTICKED);
    expect(labelOf(theButton(html))).toBe("Далее");
    expect(isDisabled(theButton(html))).toBe(true);
    expect(html).toContain("Я прочитал, действуем");
  });

  it("enables «Далее» once the box is ticked", () => {
    const button = theButton(render(ROUND_ONE_TICKED));
    expect(labelOf(button)).toBe("Далее");
    expect(isDisabled(button)).toBe(false);
  });

  it("answers the first press with a doubt, unticked and disabled", () => {
    const html = render(ROUND_TWO_UNTICKED);
    const button = theButton(html);
    expect(labelOf(button)).toBe("Не верю, что прочитал");
    // The gate has to be real in round two as well, not merely greyed.
    expect(isDisabled(button)).toBe(true);
    expect(checkbox(html)).not.toMatch(/ checked=""/);
    expect(html).toContain("Теперь точно прочитал");
    expect(html).not.toContain("Я прочитал, действуем");
  });

  it("turns the doubt back into a live «Далее» when ticked again", () => {
    const html = render(ROUND_TWO_TICKED);
    const button = theButton(html);
    expect(labelOf(button)).toBe("Далее");
    expect(isDisabled(button)).toBe(false);
    // The round-one checkbox label does not come back with it.
    expect(html).toContain("Теперь точно прочитал");
    expect(html).not.toContain("Я прочитал, действуем");
  });

  it("has no «Позже» — or any other — soft exit", () => {
    // The operator's instruction: no third state where the dialog is dismissed
    // approvingly without being read. ✕ and Esc remain, on the Radix frame.
    for (const step of [
      ROUND_ONE_UNTICKED,
      ROUND_ONE_TICKED,
      ROUND_TWO_UNTICKED,
      ROUND_TWO_TICKED,
    ]) {
      const html = render(step);
      expect(html, JSON.stringify(step)).not.toContain("Позже");
      // One button, so there is nowhere else to click out of it.
      theButton(html);
    }
  });

  it("gates the button on a checkbox that is really checked", () => {
    expect(checkbox(render(ROUND_ONE_TICKED))).toMatch(/ checked=""/);
    expect(checkbox(render(ROUND_ONE_UNTICKED))).not.toMatch(/ checked=""/);
  });

  it("asks the browser not to remember the tick", () => {
    // Without this, Chrome restores the box as ticked after a reload of the
    // same URL and the next key's dialog opens with its Next already live —
    // the one thing the gate exists to prevent. Observed, then fixed; asserted
    // here so a tidy-up cannot quietly drop the attribute again.
    expect(checkbox(render(ROUND_ONE_UNTICKED))).toMatch(/ autocomplete="off"/i);
  });

  it("announces the renamed button out of band", () => {
    // The button renames itself and goes disabled while it holds focus, and
    // assistive technology does not reliably re-read a control it is already
    // on. The live region is in the markup from the very first render — one
    // added at the same moment as its text is routinely missed — and carries
    // the new name once there is one.
    const region = /<p[^>]*role="status"[^>]*>(.*?)<\/p>/;
    const quiet = render(ROUND_ONE_UNTICKED).match(region);
    expect(quiet, "the live region must exist before it has anything to say")
      .not.toBeNull();
    expect(quiet![0]).toMatch(/aria-live="polite"/);
    expect(quiet![1]).toBe("");

    const loud = render(ROUND_TWO_UNTICKED).match(region);
    expect(loud![1]).toContain("Не верю, что прочитал");
  });

  it("names the client version the key actually needs", () => {
    // The whole reason the step is mandatory. Interpolated from the contract,
    // never typed into the copy — see the messages test.
    expect(render(ROUND_ONE_UNTICKED)).toContain(MIN_AWG3_CLIENT_VERSION);
  });
});

describe("installReminderStep", () => {
  /** Feed a whole session in, get the final state and the last verdict out. */
  const run = (...events: InstallReminderEvent[]) =>
    events.reduce(
      (carried, event) => installReminderStep(carried.step, event),
      { step: INSTALL_REMINDER_START, proceed: false },
    );

  it("starts every opening in round one, unticked", () => {
    expect(INSTALL_REMINDER_START).toEqual({
      acknowledged: false,
      challenged: false,
    });
  });

  it("does not proceed on the first press — it challenges", () => {
    // The point of the whole exercise. A user who ticked and clicked without
    // reading is asked again rather than let through.
    const pressed = run({ type: "ticked", value: true }, { type: "pressed" });
    expect(pressed.proceed).toBe(false);
    expect(pressed.step).toEqual({ acknowledged: false, challenged: true });
  });

  it("proceeds on the second press", () => {
    const done = run(
      { type: "ticked", value: true },
      { type: "pressed" },
      { type: "ticked", value: true },
      { type: "pressed" },
    );
    expect(done.proceed).toBe(true);
  });

  it("never falls back to round one on its own", () => {
    // Unticking inside round two does not hand the user the easier first
    // round back — the doubt returns, not the original question.
    const wobbled = run(
      { type: "ticked", value: true },
      { type: "pressed" },
      { type: "ticked", value: true },
      { type: "ticked", value: false },
    );
    expect(wobbled.step).toEqual({ acknowledged: false, challenged: true });
  });

  it("reopens clean, so the next key starts from round one again", () => {
    // The user got as far as round two on the previous key, then the dialog
    // closed. A stale `challenged` would let the next key's dialog through on
    // a single press; a stale `acknowledged` would open it with a live button.
    const reopened = run(
      { type: "ticked", value: true },
      { type: "pressed" },
      { type: "ticked", value: true },
      { type: "opened" },
    );
    expect(reopened.step).toEqual(INSTALL_REMINDER_START);
    // And the first press after reopening challenges rather than proceeding.
    expect(
      installReminderStep(reopened.step, { type: "pressed" }).proceed,
    ).toBe(false);
  });
});

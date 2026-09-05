import { describe, expect, it } from "vitest";
import { GUIDE_AUDIENCES } from "@amnezia/contracts";

import {
  HELP_PARAM,
  OS_PARAM,
  helpLinkSearch,
  readHelpLink,
} from "./help-links";

describe("readHelpLink", () => {
  it("opens the install guide", () => {
    expect(readHelpLink("?help=install")).toEqual({
      dialog: "install",
      audience: null,
    });
  });

  it("opens the create-key help", () => {
    expect(readHelpLink("?help=key")).toEqual({
      dialog: "key",
      audience: null,
    });
  });

  // The whole point of `os=`: a support answer is one link to the instruction
  // the person is actually holding a device for.
  it("pre-selects every device group the chooser offers", () => {
    for (const audience of GUIDE_AUDIENCES) {
      expect(readHelpLink(`?help=install&os=${audience}`)).toEqual({
        dialog: "install",
        audience,
      });
    }
  });

  it("reads a link that is missing its leading question mark", () => {
    expect(readHelpLink("help=install&os=ios")).toEqual({
      dialog: "install",
      audience: "ios",
    });
  });

  it("accepts URLSearchParams as well as a string", () => {
    const params = new URLSearchParams({ help: "install", os: "android" });
    expect(readHelpLink(params)).toEqual({
      dialog: "install",
      audience: "android",
    });
  });

  // A link travels through chat clients and gets retyped at the other end.
  it("forgives capitals and stray spaces", () => {
    expect(readHelpLink("?help=%20Install%20&os=Android")).toEqual({
      dialog: "install",
      audience: "android",
    });
  });

  // Fail soft: the guide still opens, on its chooser, because a wrong
  // instruction is worse than one more click.
  it("opens the guide unselected on an os value it does not know", () => {
    for (const os of ["", "windows-11", "iphone", "OS/2", "null", "%%%"]) {
      expect(readHelpLink(`?help=install&os=${encodeURIComponent(os)}`)).toEqual(
        { dialog: "install", audience: null },
      );
    }
  });

  it("ignores os on the dialog that has no chooser", () => {
    expect(readHelpLink("?help=key&os=android")).toEqual({
      dialog: "key",
      audience: null,
    });
  });

  // An unknown dialog name is not an error page and not an empty dialog: it is
  // simply the dashboard, as if nothing had been asked for.
  it("does nothing for a dialog name it does not know", () => {
    for (const search of [
      "",
      "?",
      "?help=",
      "?help=instal",
      "?help=guide",
      "?help=install-guide",
      "?help=keys",
      "?os=android",
      "?utm_source=chat",
    ]) {
      expect(readHelpLink(search)).toBeNull();
    }
  });

  it("never throws on a mangled query string", () => {
    for (const search of ["?%", "?help=%E0%A4%A", "?&&=&", "?help=install&%"]) {
      expect(() => readHelpLink(search)).not.toThrow();
    }
  });
});

describe("helpLinkSearch", () => {
  it("writes the parameter when a dialog opens", () => {
    expect(helpLinkSearch("", { dialog: "install", audience: null })).toBe(
      `?${HELP_PARAM}=install`,
    );
    expect(helpLinkSearch("", { dialog: "key", audience: null })).toBe(
      `?${HELP_PARAM}=key`,
    );
  });

  it("adds the device group when the reader picks one", () => {
    expect(
      helpLinkSearch("?help=install", { dialog: "install", audience: "ios" }),
    ).toBe(`?${HELP_PARAM}=install&${OS_PARAM}=ios`);
  });

  it("swaps the device group when the reader picks another", () => {
    expect(
      helpLinkSearch("?help=install&os=ios", {
        dialog: "install",
        audience: "desktop",
      }),
    ).toBe(`?${HELP_PARAM}=install&${OS_PARAM}=desktop`);
  });

  it("clears both parameters when the dialog closes", () => {
    expect(helpLinkSearch("?help=install&os=android", null)).toBe("");
    expect(helpLinkSearch("?help=key", null)).toBe("");
  });

  // Never writes `os=` on its own: copied out of the address bar it would teach
  // an operator a value that means nothing.
  it("leaves os off the key dialog and off an unchosen chooser", () => {
    expect(
      helpLinkSearch("?help=install&os=ios", { dialog: "key", audience: null }),
    ).toBe(`?${HELP_PARAM}=key`);
    expect(
      helpLinkSearch("?help=install&os=ios", {
        dialog: "install",
        audience: null,
      }),
    ).toBe(`?${HELP_PARAM}=install`);
  });

  it("keeps whatever else was on the URL", () => {
    expect(
      helpLinkSearch("?lang=en&help=key", {
        dialog: "install",
        audience: "android",
      }),
    ).toBe(`?lang=en&${HELP_PARAM}=install&${OS_PARAM}=android`);
    expect(helpLinkSearch("?lang=en&help=key&os=ios", null)).toBe("?lang=en");
  });

  // The address bar is written from the same reader that parsed the link, so a
  // link the panel produces must survive being pasted back into it.
  it("round-trips every link it can write", () => {
    for (const audience of [null, ...GUIDE_AUDIENCES]) {
      for (const dialog of ["install", "key"] as const) {
        const link = { dialog, audience: dialog === "install" ? audience : null };
        expect(readHelpLink(helpLinkSearch("", link))).toEqual(link);
      }
    }
  });
});

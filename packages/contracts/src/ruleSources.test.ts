import { describe, expect, it } from "vitest";
import {
  distinctSources,
  ruleSources,
  sourceName,
  splitSourceUrls,
} from "./ruleSources.js";

// The three URLs DEFAULT_RULE_FEEDS ships with (apps/worker/src/rules.ts).
// Named here as fixtures, not as a mapping the code consults: the assertions
// below must hold because of the URL's shape, not because these three are
// special.
const IPLIST = "https://iplist.opencck.org/?format=text&data=cidr4";
const REFILTER =
  "https://github.com/1andrevich/Re-filter-lists/releases/latest/download/domains_all.lst";
const ROSCOMVPN =
  "https://cdn.jsdelivr.net/gh/hydraponique/roscomvpn-geoip/release/text/whitelist.txt";

describe("splitSourceUrls", () => {
  it("reads the worker's space-joined column back as a list", () => {
    expect(splitSourceUrls(`${IPLIST} ${REFILTER}`)).toEqual([IPLIST, REFILTER]);
  });

  it("treats one URL and no URL as the same shape", () => {
    expect(splitSourceUrls(IPLIST)).toEqual([IPLIST]);
    expect(splitSourceUrls(null)).toEqual([]);
    expect(splitSourceUrls("")).toEqual([]);
    expect(splitSourceUrls("   ")).toEqual([]);
  });
});

describe("sourceName", () => {
  it("names a plain host by its own first meaningful label", () => {
    expect(sourceName(IPLIST)).toBe("iplist");
  });

  it("names a forge URL by the repository, not by the forge", () => {
    // Every project on GitHub shares this host, so the host cannot be the name.
    expect(sourceName(REFILTER)).toBe("Re-filter-lists");
    expect(
      sourceName("https://raw.githubusercontent.com/owner/some-list/main/a.txt"),
    ).toBe("some-list");
    expect(sourceName("https://gitlab.com/group/routes/-/raw/main/x.lst")).toBe(
      "routes",
    );
  });

  it("looks past a CDN's own path prefix and its version pin", () => {
    expect(sourceName(ROSCOMVPN)).toBe("roscomvpn-geoip");
    expect(
      sourceName("https://cdn.jsdelivr.net/gh/owner/repo@v1.2.3/list.txt"),
    ).toBe("repo");
  });

  it("skips a label that names a delivery role rather than a project", () => {
    expect(sourceName("https://cdn.example.com/list.txt")).toBe("example");
    expect(sourceName("https://raw.lists.antifilter.net/all.lst")).toBe(
      "antifilter",
    );
    expect(sourceName("https://example.org/a.txt")).toBe("example");
    // "iplist" is one word, not the delivery label "list".
    expect(sourceName("https://iplist.example.org/a.txt")).toBe("iplist");
  });

  it("still renders something for a URL it cannot parse", () => {
    expect(sourceName("not a url")).toBe("not a url");
  });

  it("derives, so a feed pointed somewhere new is named after the new place", () => {
    // The point of the whole module: no table of known providers to go stale.
    expect(sourceName("https://feeds.acme-corp.io/ru.txt")).toBe("acme-corp");
  });
});

describe("ruleSources", () => {
  it("returns every source behind a multi-source version", () => {
    expect(ruleSources(`${IPLIST} ${REFILTER}`)).toEqual([
      { url: IPLIST, name: "iplist" },
      { url: REFILTER, name: "Re-filter-lists" },
    ]);
  });

  it("keeps the full URL alongside the label", () => {
    expect(ruleSources(ROSCOMVPN)[0]?.url).toBe(ROSCOMVPN);
  });

  it("de-duplicates a URL repeated in one cell", () => {
    expect(ruleSources(`${IPLIST} ${IPLIST}`)).toHaveLength(1);
  });
});

describe("distinctSources", () => {
  it("collapses the versions of one profile to the feeds behind them", () => {
    expect(
      distinctSources([`${IPLIST} ${REFILTER}`, `${IPLIST} ${REFILTER}`, null]),
    ).toEqual([
      { url: IPLIST, name: "iplist" },
      { url: REFILTER, name: "Re-filter-lists" },
    ]);
  });

  it("keeps a source that only older versions were built from", () => {
    // A feed removed from RULE_FEEDS must not vanish from the history of the
    // versions it produced. Newest version first, so today's feeds lead.
    expect(
      distinctSources([IPLIST, `${IPLIST} ${REFILTER}`]).map((s) => s.name),
    ).toEqual(["iplist", "Re-filter-lists"]);
  });

  it("carries every full URL, not just the labels", () => {
    expect(distinctSources([`${IPLIST} ${REFILTER}`]).map((s) => s.url)).toEqual([
      IPLIST,
      REFILTER,
    ]);
  });
});

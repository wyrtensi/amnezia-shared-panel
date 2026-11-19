import { afterEach, describe, expect, it, vi } from "vitest";

import { copyVpnLink, keyDelivery } from "./key-delivery";

describe("keyDelivery", () => {
  it("keeps the link field and QR for the full tunnel", () => {
    expect(keyDelivery("full_tunnel")).toEqual({
      clipboard: "inline",
      qrUsable: true,
    });
  });

  it("allows on-demand copying without QR for the split profile", () => {
    expect(keyDelivery("ru_blacklist")).toEqual({
      clipboard: "on-demand",
      qrUsable: false,
    });
  });

  it("treats an unknown profile as file-only", () => {
    expect(keyDelivery("something_new")).toEqual({
      clipboard: "unavailable",
      qrUsable: false,
    });
  });
});

describe("copyVpnLink", () => {
  afterEach(() => vi.unstubAllGlobals());
  const href = "/test-config?format=vpn";

  it.each([14_022, 32_767])("copies the complete %i-character split key", async (length) => {
    const link = `vpn://${"x".repeat(length - 6)}`;
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const fetchConfig = vi.fn().mockResolvedValue(new Response(`${link}\n`));
    vi.stubGlobal("fetch", fetchConfig);

    await expect(copyVpnLink(href)).resolves.toBe(true);
    expect(fetchConfig).toHaveBeenCalledExactlyOnceWith(`${href}&clipboard=true`);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(link);
  });

  it("leaves the clipboard untouched when a split key would be truncated", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`vpn://${"x".repeat(32_762)}`)));

    await expect(copyVpnLink(href)).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("recognizes the API clipboard limit without writing to the clipboard", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      error: "KEY_CLIPBOARD_TOO_LONG",
      message: "Download the .vpn file",
    }, { status: 422 })));

    await expect(copyVpnLink(href)).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("surfaces an export error without writing credentials", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));

    await expect(copyVpnLink(href)).rejects.toThrow();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("starts the clipboard write during the click while the link is still loading", async () => {
    const link = "vpn://synthetic";
    let respond!: (response: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { respond = resolve; }));
    class TestClipboardItem {
      constructor(readonly data: { "text/plain": Promise<Blob> }) {}
    }
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    const write = vi.fn(async ([item]: [TestClipboardItem]) => {
      const blob = await item.data["text/plain"];
      expect(await blob.text()).toBe(link);
    });
    vi.stubGlobal("navigator", { clipboard: { write } });

    const copying = copyVpnLink(href);
    expect(write).toHaveBeenCalledTimes(1);
    respond(new Response(link));
    await expect(copying).resolves.toBe(true);
  });
});

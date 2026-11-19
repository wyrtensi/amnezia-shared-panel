import { VPN_CLIPBOARD_MAX_CHARS } from "@amnezia/contracts";

type KeyDelivery = {
  clipboard: "inline" | "on-demand" | "unavailable";
  qrUsable: boolean;
};

export function keyDelivery(routeProfile: string): KeyDelivery {
  if (routeProfile === "full_tunnel") {
    return { clipboard: "inline", qrUsable: true };
  }
  if (routeProfile === "ru_blacklist") {
    return { clipboard: "on-demand", qrUsable: false };
  }
  return { clipboard: "unavailable", qrUsable: false };
}

export async function copyVpnLink(href: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  const pendingLink = fetch(`${href}&clipboard=true`).then(async (res) => {
    if (res.status === 422) {
      const body = (await res.json()) as { error?: string };
      if (body.error === "KEY_CLIPBOARD_TOO_LONG") return null;
    }
    if (!res.ok) throw new Error(`Config export failed (${res.status})`);
    const link = (await res.text()).trim();
    return link.length > VPN_CLIPBOARD_MAX_CHARS ? null : link;
  });

  if (typeof ClipboardItem !== "undefined" && typeof clipboard?.write === "function") {
    // Start writing during the click to preserve user activation in WebKit.
    // A rejected ClipboardItem leaves the previous clipboard contents intact.
    const data = pendingLink.then((link) => {
      if (link === null) throw new Error("VPN key exceeds the clipboard import limit");
      return new Blob([link], { type: "text/plain" });
    });
    const write = async () => clipboard.write([new ClipboardItem({ "text/plain": data })]);
    const [link, item, written] = await Promise.allSettled([pendingLink, data, write()]);
    if (link.status === "rejected") throw link.reason;
    if (link.value === null) return false;
    if (item.status === "rejected") throw item.reason;
    if (written.status === "rejected") throw written.reason;
    return true;
  }

  const link = await pendingLink;
  if (link === null) return false;
  await clipboard.writeText(link);
  return true;
}

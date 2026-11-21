/**
 * Test-only: expand AmneziaWG signature packet templates into bytes the way
 * the client does, and parse DNS and STUN packets strictly enough to say
 * whether a real stack could have sent them.
 */

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** A deterministic byte source, so a failure reproduces. */
export const seededBytes = (seed: number) => {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) & 0xff;
  };
};

/** `<b 0x..>` literal bytes, `<r N>` random bytes, `<rc N>` random letters. */
export const expandTemplate = (template: string, nextByte: () => number): Uint8Array => {
  const out: number[] = [];
  const tags = template.match(/<[^>]+>/g) ?? [];
  if (tags.join("") !== template) throw new Error(`Malformed template: ${template}`);
  for (const tag of tags) {
    const literal = /^<b 0x([0-9a-f]*)>$/.exec(tag);
    if (literal) {
      const hex = literal[1] ?? "";
      if (hex.length % 2 !== 0) throw new Error(`Odd hex in ${tag}`);
      for (let index = 0; index < hex.length; index += 2) out.push(parseInt(hex.slice(index, index + 2), 16));
      continue;
    }
    const random = /^<(r|rc) (\d+)>$/.exec(tag);
    if (!random) throw new Error(`Unknown tag ${tag}`);
    for (let index = 0; index < Number(random[2]); index += 1) {
      out.push(random[1] === "rc" ? LETTERS.charCodeAt(nextByte() % LETTERS.length) : nextByte());
    }
  }
  return Uint8Array.from(out);
};

const PRIVATE_OR_RESERVED_FIRST_OCTETS = new Set([0, 10, 100, 127, 169, 172, 192, 198]);

export type ParsedDns = {
  response: boolean;
  labels: string[];
  qtype: number;
  edns: { udpSize: number; dnssecOk: boolean } | null;
  answer: { ttl: number; ipv4: number[] } | null;
};

/** RFC 1035 / 2181 / 6891: one question, an A answer with a 0xc00c pointer for responses, an optional OPT record. */
export const parseDns = (packet: Uint8Array): ParsedDns => {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const u16 = (at: number) => view.getUint16(at);
  if (packet.length < 12) throw new Error("short header");
  const flags = u16(2);
  const [qd, an, ns, ar] = [u16(4), u16(6), u16(8), u16(10)];
  const response = flags === 0x8180;
  if (!response && flags !== 0x0100) throw new Error(`flags ${flags.toString(16)}`);
  if (qd !== 1 || ns !== 0 || an !== (response ? 1 : 0) || ar > 1) throw new Error("counts");
  let at = 12;
  const labels: string[] = [];
  let nameLength = 1;
  for (;;) {
    const length = packet[at] ?? -1;
    if (length === 0) { at += 1; break; }
    if (length < 1 || length > 63) throw new Error(`label length ${length}`);
    const label = String.fromCharCode(...packet.slice(at + 1, at + 1 + length));
    if (!/^[a-z0-9-]+$/i.test(label)) throw new Error(`label ${label}`);
    labels.push(label);
    nameLength += length + 1;
    at += length + 1;
  }
  if (nameLength > 255 || labels.length < 2) throw new Error("name");
  const qtype = u16(at);
  if (u16(at + 2) !== 1) throw new Error("qclass");
  at += 4;
  let answer: ParsedDns["answer"] = null;
  if (response) {
    if (u16(at) !== 0xc00c || u16(at + 2) !== 1 || u16(at + 4) !== 1) throw new Error("answer header");
    const ttl = view.getUint32(at + 6);
    if (ttl < 1 || ttl > 0x7fffffff) throw new Error(`ttl ${ttl}`);
    if (u16(at + 10) !== 4) throw new Error("rdlength");
    const ipv4 = [...packet.slice(at + 12, at + 16)];
    const first = ipv4[0] ?? 0;
    if (PRIVATE_OR_RESERVED_FIRST_OCTETS.has(first) || first >= 224) throw new Error(`ipv4 ${ipv4.join(".")}`);
    answer = { ttl, ipv4 };
    at += 16;
  }
  let edns: ParsedDns["edns"] = null;
  if (ar === 1) {
    if (packet[at] !== 0 || u16(at + 1) !== 41) throw new Error("opt name/type");
    const udpSize = u16(at + 3);
    if (udpSize < 512) throw new Error("opt size");
    if (packet[at + 5] !== 0 || packet[at + 6] !== 0) throw new Error("opt rcode/version");
    const optFlags = u16(at + 7);
    if ((optFlags & 0x7fff) !== 0) throw new Error("opt flags");
    if (u16(at + 9) !== 0) throw new Error("opt rdlength");
    edns = { udpSize, dnssecOk: optFlags === 0x8000 };
    at += 11;
  }
  if (at !== packet.length) throw new Error(`trailing ${packet.length - at}`);
  return { response, labels, qtype, edns, answer };
};

// SOFTWARE and CHANGE-REQUEST only: PRIORITY and ICE-CONTROLLING without
// USERNAME and MESSAGE-INTEGRITY are not what an ICE agent sends.
const STUN_ATTRIBUTES = new Set([0x8022, 0x0003]);

/** RFC 5389 Binding Request: header, matching length, padded SOFTWARE / CHANGE-REQUEST, no FINGERPRINT. */
export const parseStun = (packet: Uint8Array): { size: number; attributes: number[] } => {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (packet.length < 20 || packet.length > 44) throw new Error(`size ${packet.length}`);
  if (view.getUint16(0) !== 0x0001) throw new Error("type");
  const length = view.getUint16(2);
  if (length !== packet.length - 20 || length % 4 !== 0) throw new Error("length");
  if (view.getUint32(4) !== 0x2112a442) throw new Error("cookie");
  const attributes: number[] = [];
  let at = 20;
  while (at < packet.length) {
    const type = view.getUint16(at);
    const valueLength = view.getUint16(at + 2);
    if (!STUN_ATTRIBUTES.has(type)) throw new Error(`attribute ${type.toString(16)}`);
    if (type === 0x0003 && valueLength !== 4) throw new Error("change-request");
    attributes.push(type);
    at += 4 + Math.ceil(valueLength / 4) * 4;
  }
  if (at !== packet.length) throw new Error("attribute overrun");
  return { size: packet.length, attributes };
};

export type PacketKind = "dns" | "stun" | "noise";

/** Which parser a template's bytes belong to. */
export const packetKind = (template: string): PacketKind => {
  if (/^<r \d+>$/.test(template)) return "noise";
  if (template.startsWith("<b 0x0001") && template.includes("2112a442")) return "stun";
  return "dns";
};

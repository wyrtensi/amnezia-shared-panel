import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const preflightUrl = new URL("../scripts/preflight.sh", import.meta.url);
const script = await readFile(preflightUrl, "utf8");
/** Comments quote the very constructs some of these tests forbid. */
const code = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

test("the API key charset check stays linear in the key length", async () => {
  // `grep -E '^[[:graph:]]{32,4096}$'` expands the bounded interval into an
  // automaton costing ~280 MB RSS and ~20 s on one vCPU (measured, GNU grep
  // 3.11). On a small node the OOM killer reaps it and the script then blames
  // a perfectly valid key.
  assert.doesNotMatch(code, /\[\[:graph:\]\]\{/);
  assert.match(code, /tr -d '\[:graph:\]'/);
});

test("the RAM gate names the lever that lowers it", async () => {
  const gate = code.slice(
    code.indexOf("required_mem_kb="),
    code.indexOf("forbidden_found=0"),
  );
  // The gate scales with declared capacity, and the template ships the 500-peer
  // maximum — so an operator who hits this needs to be told that lowering
  // SERVER_MAX_PEERS is the supported response, not just what the number is.
  assert.match(gate, /SERVER_MAX_PEERS/);
});

test("the disk gate says how to reclaim the space it wants", async () => {
  const gate = code.slice(code.indexOf("available_kb="), code.indexOf("available_mem_kb="));
  // Free space is the constraint that actually binds on a small host, and it is
  // almost always reclaimable rather than absent.
  assert.match(gate, /docker image prune/);
  assert.match(gate, /journalctl --vacuum-size/);
});

const envExampleUrl = new URL("../.env.example", import.meta.url);
// Windows checkouts may carry CRLF; the CI job runs on Linux with LF.
const normalize = (text) => text.replace(/\r\n/g, "\n");
const preflight = normalize(script);
const envExample = normalize(await readFile(envExampleUrl, "utf8"));

const publicHostPlaceholder = () => {
  const value = /^SERVER_PUBLIC_HOST=(.*)$/m.exec(envExample)?.[1];
  assert.ok(value, ".env.example must define SERVER_PUBLIC_HOST");
  return value;
};

const rejectedPublicHosts = () => {
  const match =
    /public_host="\$\(env_value SERVER_PUBLIC_HOST\)"\ncase "\$public_host" in\n +([^)\n]+)\)\n +fail /.exec(
      preflight,
    );
  assert.ok(match, "preflight must reject a fixed list of SERVER_PUBLIC_HOST values");
  return match[1].split("|");
};

test("the .env.example SERVER_PUBLIC_HOST placeholder is an unroutable IPv4 literal", () => {
  // RFC 5737 TEST-NET-3 is documentation-only and never routed, so a template
  // copied without editing can never point clients at a real host.
  assert.match(publicHostPlaceholder(), /^203\.0\.113\.\d{1,3}$/);
});

test("preflight rejects the .env.example placeholder and the one it replaced", () => {
  const rejected = rejectedPublicHosts();
  assert.ok(rejected.includes(publicHostPlaceholder()), "current placeholder must be rejected");
  // Copies of the old template are still deployed; keep rejecting its value.
  assert.ok(rejected.includes("vpn.example.com"), "previous placeholder must stay rejected");
});

test("preflight insists on an IPv4 address for SERVER_PUBLIC_HOST without failing on a DNS name", () => {
  // One case arm, on one line, so the handler is unambiguous: capture the
  // command it runs and the message it prints.
  const advisory =
    /^ +\*\[!0-9\.\]\*\) (\w+) "(NOTE: SERVER_PUBLIC_HOST is a DNS name[^"]*)" ;;$/m.exec(preflight);
  assert.ok(advisory, "preflight must carry a one-line DNS-name advisory");
  // `info` writes to stdout and returns; `fail` exits 1. This is the whole
  // difference between an advisory and a gate, so assert on it directly.
  assert.equal(advisory[1], "info", "the DNS-name advisory must not be a hard failure");
  // The recommendation is insistent and the fix is to resolve the name on the
  // server, so the line must say both.
  assert.match(advisory[2], /strongly recommended/);
  assert.match(advisory[2], /resolve/i);
});

test("the disk gate is a floor derived from what a deploy pulls, not a round number", () => {
  // 2 GiB, not 3: the only image a deploy actually pulls is the node-agent
  // (~500 MiB; the AWG images are pinned by digest and already present), plus
  // transient space to extract it and a state backup measured in kilobytes.
  // A gate four times the largest pull is a floor; the old 3 GiB was an
  // unexplained constant that refused hosts the deploy would have fitted on.
  const gate = /\[ "\$available_kb" -ge (\d+) \]/.exec(preflight);
  assert.ok(gate, "preflight must gate on free disk");
  assert.equal(gate[1], "2097152");
});

test("preflight still recommends 3 GiB, as advice rather than a refusal", () => {
  // Below the recommendation the host is one deploy away from trouble, so it
  // must be told - but a node that fits is not stopped from redeploying.
  const advisory =
    /^ +(\w+) "(NOTE: free disk is below the recommended[^"]*)"$/m.exec(preflight);
  assert.ok(advisory, "preflight must carry a free-disk advisory");
  assert.equal(advisory[1], "info", "the disk recommendation must not be a gate");
  assert.match(advisory[2], /3 GiB/);
  // Same rule as every other advisory here: say how to fix it, not just what.
  assert.match(advisory[2], /journalctl --vacuum-size/);
});

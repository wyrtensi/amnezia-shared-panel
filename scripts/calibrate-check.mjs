#!/usr/bin/env node
/**
 * Derive a service-check marker from two captures, and never from one.
 *
 * On a single page the absence of a marker cannot be told apart from the
 * absence of evidence: not finding "not available in your country" says only
 * that one guessed string was absent. So this tool does two things and refuses
 * to do the third:
 *
 *   capture  fetch a page the way the node-agent's probe fetches it, and save
 *            exactly what was SERVED - not what a browser builds afterwards
 *   diff     compare two captures and rank the strings that separate them
 *
 * It will not propose a marker from one capture. That restriction is the whole
 * point: a check built from the working side alone is a check that has never
 * been shown to notice anything.
 *
 * Usage:
 *   node scripts/calibrate-check.mjs capture --url=<url> --out=<file>
 *   node scripts/calibrate-check.mjs diff <working.html> <blocked.html>
 *
 * Capture the SAME url twice from the same machine: once on an address the
 * service accepts, once on one it refuses. Same machine matters - two different
 * clients differ in ways that have nothing to do with the block.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import http from "node:http";

/**
 * What the probe reads, mirrored here so a marker this tool proposes is one the
 * probe can actually see. A marker past the body cap is invisible to a check.
 */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const TIMEOUT_MS = 15_000;
const USER_AGENT = "amnezia-node-agent-check/1";

// Node's default response-header limit is 16 KiB, and real sites exceed it -
// gemini.google.com does, and the probe failed with UND_ERR_HEADERS_OVERFLOW
// until the agent was started with a larger one. Re-exec rather than print an
// instruction: an operator who forgets the flag gets a network-looking error
// that has nothing to do with the network.
if (http.maxHeaderSize < MAX_HEADER_BYTES) {
  const result = spawnSync(
    process.execPath,
    [`--max-http-header-size=${MAX_HEADER_BYTES}`, ...process.argv.slice(1)],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

const flag = (name) => {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : undefined;
};

const capture = async () => {
  const url = flag("url");
  const out = flag("out");
  if (!url || !out) {
    throw new Error("capture needs --url=<url> and --out=<file>");
  }
  // Refuse to overwrite. The whole workflow is "capture twice and keep both",
  // and a second capture written over the first destroys exactly the half that
  // cannot be taken again later - the one from the refused address. This has
  // already happened once.
  if (!process.argv.includes("--force") && existsSync(out)) {
    throw new Error(
      `${out} already exists. Capture the two addresses to two files ` +
        `(working.html and blocked.html), or pass --force to overwrite.`,
    );
  }
  const started = Date.now();
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    },
  });
  const body = await response.text();
  await writeFile(out, body, "utf8");
  // A sidecar, so a capture says what it is months later. Which address it came
  // from is the one thing a file of HTML cannot tell you.
  await writeFile(
    `${out}.json`,
    JSON.stringify(
      {
        url,
        finalUrl: response.url,
        status: response.status,
        bytes: body.length,
        capturedAt: new Date().toISOString(),
        note: "Record here whether this address was accepted or refused.",
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`url        ${url}`);
  console.log(`final url  ${response.url}`);
  console.log(`status     ${response.status}`);
  console.log(`bytes      ${body.length} (the probe reads the first ${MAX_BODY_BYTES})`);
  console.log(`latency    ${Date.now() - started} ms`);
  console.log(`saved      ${out}`);
  console.log("");
  console.log("Now capture the same url from the other address, then run:");
  console.log(`  node scripts/calibrate-check.mjs diff <working> <blocked>`);
};

/**
 * Identifier-shaped strings: CSS class names, ids, data attributes, route
 * fragments. Deliberately not every word - prose differs between two renders of
 * the same page for reasons that have nothing to do with a block.
 */
const TOKEN = /[A-Za-z][A-Za-z0-9_-]{5,60}/g;

const tally = (text) => {
  const counts = new Map();
  const firstAt = new Map();
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0];
    counts.set(token, (counts.get(token) ?? 0) + 1);
    if (!firstAt.has(token)) firstAt.set(token, match.index);
  }
  return { counts, firstAt };
};

/**
 * A token that looks like it was minted for this one page load.
 *
 * Every page Google serves carries fresh nonces, consent blobs and randomised
 * example prompts. They appear in exactly one capture and never in the other,
 * which makes them look like PERFECT markers and makes them the worst possible
 * choice: a check built on one flips on every load, for every node, forever.
 *
 * Judged on shape rather than by a list: long, mixed case, or mixed letters and
 * digits with no word-like structure.
 */
const looksLikeNonce = (token) => {
  if (token.length >= 16 && /[A-Z]/.test(token) && /[a-z]/.test(token)) return true;
  if (token.length >= 12 && /\d/.test(token) && /[A-Za-z]/.test(token) && !/^[a-z-]+$/.test(token)) {
    return true;
  }
  return false;
};

/**
 * Do these two captures actually differ the way a working and a refused page
 * differ? A refusal is a DIFFERENT PAGE: another status, another final URL, or
 * a body a fraction of the size. Two captures of the same app shell differ only
 * in per-load noise, and proposing markers from that pair is worse than
 * proposing nothing.
 */
const looksLikeSamePage = (a, b) => {
  if (!a || !b) return null;
  const sameStatus = a.status === b.status;
  const sameFinal = a.finalUrl === b.finalUrl;
  const ratio =
    Math.min(a.bytes, b.bytes) / Math.max(a.bytes, b.bytes || 1);
  return sameStatus && sameFinal && ratio > 0.9
    ? { sameStatus, sameFinal, ratio }
    : null;
};

const readSidecar = async (path) => {
  try {
    return JSON.parse(await readFile(`${path}.json`, "utf8"));
  } catch {
    return null;
  }
};

const diff = async () => {
  const [, , , workingPath, blockedPath] = process.argv;
  if (!workingPath || !blockedPath) {
    throw new Error("diff needs <working.html> <blocked.html>");
  }
  const [working, blocked] = await Promise.all([
    readFile(workingPath, "utf8"),
    readFile(blockedPath, "utf8"),
  ]);
  const [metaA, metaB] = await Promise.all([
    readSidecar(workingPath),
    readSidecar(blockedPath),
  ]);
  const same = looksLikeSamePage(metaA, metaB);
  if (same) {
    console.log("");
    console.log("!! THESE TWO CAPTURES LOOK LIKE THE SAME PAGE.");
    console.log(
      `!! Both answered ${metaA.status} at ${metaA.finalUrl}, and their sizes are within ` +
        `${Math.round((1 - same.ratio) * 100)}% of each other (${metaA.bytes} vs ${metaB.bytes}).`,
    );
    console.log("!!");
    console.log("!! A refusal is a DIFFERENT page: another status, another final URL, or a");
    console.log("!! body a fraction of the size. What follows is almost certainly per-load");
    console.log("!! noise - fresh nonces, consent blobs, randomised example prompts - and a");
    console.log("!! check built on any of it would flip on every load, on every node.");
    console.log("!!");
    console.log("!! Capture again and check the refused address was actually in effect. If it");
    console.log("!! was, that address is not refused for this service, and there is nothing");
    console.log("!! here to detect.");
  }
  const a = tally(working);
  const b = tally(blocked);

  const rows = [];
  for (const [token, count] of a.counts) {
    const other = b.counts.get(token) ?? 0;
    if (other === 0 && count >= 2) {
      rows.push({ token, working: count, blocked: 0, at: a.firstAt.get(token), kind: "success" });
    }
  }
  for (const [token, count] of b.counts) {
    const other = a.counts.get(token) ?? 0;
    if (other === 0 && count >= 2) {
      rows.push({ token, working: 0, blocked: count, at: b.firstAt.get(token), kind: "failure" });
    }
  }
  // Reachable first, then by how loudly it separates the two pages.
  rows.sort(
    (left, right) =>
      Number(looksLikeNonce(left.token)) - Number(looksLikeNonce(right.token)) ||
      Number(left.at >= MAX_BODY_BYTES) - Number(right.at >= MAX_BODY_BYTES) ||
      Math.max(right.working, right.blocked) - Math.max(left.working, left.blocked),
  );

  const show = (kind, title, note) => {
    const list = rows.filter((row) => row.kind === kind).slice(0, 12);
    console.log(`\n${title}`);
    console.log(note);
    if (list.length === 0) {
      console.log("  (none)");
      return;
    }
    for (const row of list) {
      const notes = [];
      if (row.at >= MAX_BODY_BYTES) notes.push("PAST THE 64 KiB CAP - unusable");
      // Named rather than hidden: an operator who sees a nonce ranked first and
      // no explanation will reasonably assume it is the answer.
      if (looksLikeNonce(row.token)) notes.push("looks like a per-load nonce - do not use");
      console.log(
        `  ${row.token.padEnd(42)} working=${String(row.working).padStart(4)} blocked=${String(row.blocked).padStart(4)} first@${row.at}` +
          (notes.length ? `  [${notes.join("; ")}]` : ""),
      );
    }
  };

  show(
    "success",
    "SUCCESS markers - present when it works, absent when it does not",
    "  Prefer these. A success marker fails for ANY reason the page is missing;\n" +
      "  a failure marker only catches the exact refusal served on capture day.",
  );
  show(
    "failure",
    "FAILURE markers - present only on the refused page",
    "  Useful as an independent second assertion, not as the only one.",
  );

  // The near-misses. `input-area-container` is the recorded example: 58 hits on
  // a blocked page and 86 on a working one, so it reads like the right class
  // and is green from a blocked node in one direction and red from a working
  // one in the other.
  const traps = [];
  for (const [token, count] of a.counts) {
    const other = b.counts.get(token) ?? 0;
    if (other > 0 && count > 0 && Math.abs(count - other) >= 5) {
      traps.push({ token, working: count, blocked: other });
    }
  }
  traps.sort((left, right) => Math.abs(right.working - right.blocked) - Math.abs(left.working - left.blocked));
  console.log("\nTRAPS - present on BOTH pages, only the count differs");
  console.log("  Do not assert on these. They read like the right marker and are");
  console.log("  green from a blocked node one way, red from a working node the other.");
  for (const trap of traps.slice(0, 8)) {
    console.log(`  ${trap.token.padEnd(42)} working=${String(trap.working).padStart(4)} blocked=${String(trap.blocked).padStart(4)}`);
  }
  if (traps.length === 0) console.log("  (none)");

  console.log(
    "\nTurn a chosen marker into a check with:\n" +
      "  amnezia-panel check-create --name=<name> --url=<url> \\\n" +
      "    --status-in=200 --contains-at-least=<count>:<marker>",
  );
};

const mode = process.argv[2];
try {
  if (mode === "capture") await capture();
  else if (mode === "diff") await diff();
  else {
    console.log(
      "Usage:\n" +
        "  node scripts/calibrate-check.mjs capture --url=<url> --out=<file>\n" +
        "  node scripts/calibrate-check.mjs diff <working.html> <blocked.html>\n\n" +
        "Capture the same url twice from the same machine: once on an address the\n" +
        "service accepts, once on one it refuses.",
    );
    process.exit(2);
  }
} catch (error) {
  console.error(`calibrate-check: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

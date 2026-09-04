import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(
  new URL("../scripts/awg3-geometry.sh", import.meta.url),
);

const executing = {
  skip: process.platform === "linux" ? false : "needs a POSIX shell",
};

/** One generated parameter block, as a key -> value map. */
const generate = (mtu = "1376") => {
  const result = spawnSync("sh", [scriptPath, mtu], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const params = {};
  for (const line of result.stdout.split("\n")) {
    const match = /^([A-Za-z0-9]+) = (.*)$/.exec(line);
    if (match) params[match[1]] = match[2];
  }
  return { params, raw: result.stdout };
};

const num = (params, key) => {
  assert.match(params[key] ?? "", /^\d+$/, `${key} must be a plain integer`);
  return Number(params[key]);
};

// 40 draws: the invariants below are probabilistic failures, and a single run
// would pass with a broken generator most of the time.
const DRAWS = 40;

test("emits every key the client needs, as plain integers", executing, () => {
  const { params } = generate();

  // iOS and macOS silently drop the whole AWG block - connecting as plain
  // WireGuard, with no error - if any of these is missing or empty. It is the
  // worst client-side failure mode there is, because it looks like success.
  for (const key of ["Jc", "Jmin", "Jmax", "S1", "S2", "H1", "H2", "H3", "H4"]) {
    assert.match(params[key] ?? "", /\S/, `${key} must be present and non-empty`);
  }
  // Android's toInt(), Apple's UInt16() and Windows' parseUint16 all hard-fail
  // on a range in these keys, so a range here bricks the config everywhere.
  for (const key of ["Jc", "Jmin", "Jmax", "S1", "S2", "S3", "S4"]) {
    assert.doesNotMatch(params[key] ?? "", /-/, `${key} must not be a range`);
  }
});

test("keeps S1..S4 above the header-protection nonce floor", executing, () => {
  // amneziawg-go rejects the device outright when header protection is set and
  // any S is below the 12-byte cipher nonce.
  for (let i = 0; i < DRAWS; i += 1) {
    const { params } = generate();
    for (const key of ["S1", "S2", "S3", "S4"]) {
      assert.ok(num(params, key) >= 12, `${key}=${params[key]} is below 12`);
    }
    assert.ok(num(params, "S1") <= 150);
    assert.ok(num(params, "S2") <= 150);
    assert.ok(num(params, "S3") <= 64);
  }
});

test("fits S4 inside the MTU budget it is given", executing, () => {
  // S4 is the only S that costs payload: S4 + 32 + tunnelMTU + 28 <= pathMTU.
  for (const mtu of ["1376", "1420"]) {
    for (let i = 0; i < 10; i += 1) {
      const { params } = generate(mtu);
      assert.ok(
        num(params, "S4") + 32 + Number(mtu) + 28 <= 1500,
        `S4=${params.S4} does not fit an MTU of ${mtu}`,
      );
    }
  }
});

test("never inverts the junk range", executing, () => {
  // The one that is not merely wrong but dangerous: amneziawg-go computes the
  // junk size as `min + fastrandn(max - min)` on uint32 and validates nothing,
  // so Jmax < Jmin wraps to a ~4 GB allocation per junk packet per handshake.
  // Nothing downstream protects us; the generator has to.
  for (let i = 0; i < DRAWS; i += 1) {
    const { params } = generate();
    assert.ok(
      num(params, "Jmin") < num(params, "Jmax"),
      `Jmin=${params.Jmin} Jmax=${params.Jmax}`,
    );
    assert.ok(num(params, "Jmax") <= 1000);
    assert.ok(num(params, "Jc") >= 1 && num(params, "Jc") <= 12);
  }
});

test("draws four distinct magic headers, clear of the WireGuard message types", executing, () => {
  for (let i = 0; i < DRAWS; i += 1) {
    const { params } = generate();
    const headers = ["H1", "H2", "H3", "H4"].map((key) => num(params, key));

    // amneziawg-go refuses a device whose headers overlap.
    assert.equal(new Set(headers).size, 4, `headers collide: ${headers.join()}`);
    for (const value of headers) {
      // 0..4 are the literal WireGuard message types: using one makes the type
      // field indistinguishable from plain WireGuard, which is the opposite of
      // the point. 0 additionally round-trips as "unset".
      assert.ok(value >= 16, `header ${value} is too low`);
      assert.ok(value < 2 ** 31, `header ${value} is out of range`);
    }
  }
});

test("keeps the four packet classes at distinct sizes", executing, () => {
  // The server tolerates a collision here; amnezia-client's settings UI rejects
  // the config outright, so an operator would find out only when a user
  // complains that the app will not accept their key.
  for (let i = 0; i < DRAWS; i += 1) {
    const { params } = generate();
    const sizes = [
      num(params, "S1") + 148,
      num(params, "S2") + 92,
      num(params, "S3") + 64,
      num(params, "S4") + 32,
    ];
    assert.equal(new Set(sizes).size, 4, `size classes collide: ${sizes.join()}`);
  }
});

test("builds a junk packet only from tags the parser knows", executing, () => {
  for (let i = 0; i < DRAWS; i += 1) {
    const { params } = generate();
    const spec = params.I1 ?? "";
    assert.match(spec, /^</, "I1 must start with a tag");

    const tags = [...spec.matchAll(/<([^>]*)>/g)].map((match) => match[1]);
    assert.ok(tags.length > 0, "a spec with no tags is silently skipped");
    for (const tag of tags) {
      const [key, arg] = tag.split(/\s+/);
      // <c N> does not exist, and <d>/<ds>/<dz> emit nothing in an I-packet.
      assert.ok(["b", "r", "rc", "rd", "t"].includes(key), `unknown tag <${tag}>`);
      if (key === "b") {
        assert.match(arg ?? "", /^0x[0-9a-f]+$/, `bad hex in <${tag}>`);
        assert.equal(
          (arg.length - 2) % 2,
          0,
          `<${tag}> has an odd number of hex digits`,
        );
      }
      if (key !== "b" && key !== "t") {
        assert.match(arg ?? "", /^\d+$/, `<${tag}> needs a non-negative count`);
      }
    }
  }
});

test("writes I1 flush-left, because an indented one breaks awg setconf", executing, () => {
  const { raw } = generate();
  const line = raw.split("\n").find((candidate) => candidate.startsWith("I1"));

  assert.ok(line, "I1 must be emitted");
  assert.doesNotMatch(line, /^\s/);
  assert.doesNotMatch(line, /#/);
});

test("actually randomises: two nodes do not share a geometry", executing, () => {
  const first = generate().params;
  const second = generate().params;

  // The whole reason for this change: identical geometry on every node means a
  // classifier that learns one node has learned the fleet.
  const differing = Object.keys(first).filter(
    (key) => first[key] !== second[key],
  );
  assert.ok(
    differing.length >= 6,
    `two draws shared too much: only ${differing.join()} differed`,
  );
});

test("the entrypoint uses the generator instead of hardcoding the geometry", async () => {
  const entrypoint = (
    await readFile(new URL("../scripts/awg3-entrypoint.sh", import.meta.url), "utf8")
  ).replace(/\r\n/g, "\n");
  const code = entrypoint
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  assert.match(code, /awg3-geometry\.sh/);
  // The constants that made every node in the fleet look the same.
  assert.doesNotMatch(code, /^Jc = 4$/m);
  assert.doesNotMatch(code, /^Jmin = 40$/m);
  assert.doesNotMatch(code, /^S1 = 15$/m);
  assert.doesNotMatch(code, /icloud/, "the stock junk packet must be gone");
});

// --- the 3.1-specific parameters ------------------------------------------
// Geometry alone is the AWG-2.x-era knob. These are what 3.1 actually adds,
// and leaving them unset means running stock WireGuard timings and stock
// pad-to-16 behind an otherwise obfuscated handshake.

/** `lo-hi` -> [lo, hi]; asserts the range form on the way. */
const range = (params, key) => {
  const value = params[key] ?? "";
  const match = /^(\d+)-(\d+)$/.exec(value);
  assert.ok(match, `${key}="${value}" must be a lo-hi range`);
  const lo = Number(match[1]);
  const hi = Number(match[2]);
  assert.ok(lo <= hi, `${key}: ${lo} > ${hi}`);
  // The six u16 range keys are silently truncated above 65535 by the tools:
  // RekeyAfterTime = 70000 quietly becomes 4464.
  assert.ok(hi <= 65535, `${key}: ${hi} does not fit a uint16`);
  return [lo, hi];
};

test("uses the 3.1 parameters at all", executing, () => {
  const { params } = generate();

  for (const key of [
    "ContentPaddingAddition",
    "RekeyAfterTime",
    "RekeyTimeout",
    "RejectAfterTime",
    "KeepaliveTimeout",
    "MaxHandshakeAttempts",
    "RandomTrailers",
    "DisableCookies",
  ]) {
    assert.match(params[key] ?? "", /\S/, `${key} must be set`);
  }
});

test("replaces WireGuard's pad-to-16 with real length entropy", executing, () => {
  // Stock WireGuard makes every ciphertext length a multiple of 16, which is a
  // strong classifier on its own. ContentPaddingAddition takes precedence over
  // the trailer padding and removes that lattice.
  for (let i = 0; i < DRAWS; i += 1) {
    const [lo, hi] = range(generate().params, "ContentPaddingAddition");
    assert.equal(lo, 1, "padding must start at 1, or the lattice survives");
    assert.ok(hi >= 16, `an upper bound of ${hi} barely moves the length`);
  }
});

test("keeps the timings coherent with each other", executing, () => {
  // Get these wrong and the tunnel stalls rather than fails loudly: a keypair
  // rejected before it can be rekeyed, or a keepalive that never fires inside
  // the session's life.
  for (let i = 0; i < DRAWS; i += 1) {
    const { params } = generate();
    const [, rekeyHi] = range(params, "RekeyAfterTime");
    const [rejectLo] = range(params, "RejectAfterTime");
    const [, keepaliveHi] = range(params, "KeepaliveTimeout");
    const [, rekeyTimeoutHi] = range(params, "RekeyTimeout");
    range(params, "MaxHandshakeAttempts");

    assert.ok(rekeyHi < rejectLo, `rekey ${rekeyHi} must be below reject ${rejectLo}`);
    assert.ok(
      rejectLo > keepaliveHi + rekeyTimeoutHi,
      `reject ${rejectLo} must exceed keepalive+rekeyTimeout ${keepaliveHi + rekeyTimeoutHi}`,
    );
    // A client that does not parse RejectAfterTime runs the stock 180 s. Going
    // below it would drop that client's traffic early.
    assert.ok(rejectLo >= 180, `reject ${rejectLo} is below the stock floor`);
  }
});

test("destroys the 120-second rekey beat", executing, () => {
  // A fresh value is drawn on every timer arm, so a range gives a genuinely
  // non-periodic pattern rather than a shifted constant. A zero-width range
  // would just move the beat.
  const seen = new Set();
  for (let i = 0; i < DRAWS; i += 1) {
    const [lo, hi] = range(generate().params, "RekeyAfterTime");
    assert.ok(hi > lo, "a zero-width rekey range is still a beat");
    seen.add(`${lo}-${hi}`);
  }
  assert.ok(seen.size > 1, "the rekey range must differ between nodes");
});

test("holds RandomTrailers on, uniformly", executing, () => {
  // It must match between the two ends, and a boolean carries one bit of
  // per-node entropy — randomising it buys nothing and costs compatibility.
  const draws = new Set();
  for (let i = 0; i < 8; i += 1) draws.add(generate().params.RandomTrailers);

  assert.deepEqual([...draws], ["on"]);
});

test("uses more than one junk slot, and varies which", executing, () => {
  const slotsPerDraw = [];
  for (let i = 0; i < DRAWS; i += 1) {
    const { params } = generate();
    const used = ["I1", "I2", "I3", "I4", "I5"].filter((key) => params[key]);
    assert.ok(used.length >= 2, `only ${used.length} junk slot(s) used`);
    slotsPerDraw.push(used.join(","));
  }
  // Which slots are occupied is itself a fingerprint if it never changes.
  assert.ok(new Set(slotsPerDraw).size > 1, "the slot layout never varies");
});

test("puts a range only where a range is legal", executing, () => {
  // Android toInt(), Apple UInt16() and Windows parseUint16 all hard-fail on a
  // range in the junk-size keys, so one there bricks the config everywhere.
  const { params } = generate();
  for (const key of ["Jc", "Jmin", "Jmax", "S1", "S2", "S3", "S4"]) {
    assert.doesNotMatch(params[key] ?? "", /-/, `${key} must not be a range`);
  }
  for (const key of ["H1", "H2", "H3", "H4"]) {
    assert.match(params[key] ?? "", /^\d+$/, `${key} must be a single value`);
  }
});

// --- the entrypoint's init path, actually executed -------------------------
// The blocker this catches: the geometry moved into a generator, but a
// distinctness check comparing $h1..$h4 was left behind. Under `set -eu` that
// is an unbound variable and the container dies before writing a config — and
// a test that only read the script as text saw nothing wrong.

const entrypointPath = fileURLToPath(
  new URL("../scripts/awg3-entrypoint.sh", import.meta.url),
);

test("the entrypoint writes a complete config on a fresh node", executing, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "awg3-init-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  await mkdir(bin, { recursive: true });

  // Stubs for everything the init path shells out to. `awg pubkey` must be a
  // deterministic function of its input, because the entrypoint re-derives the
  // public key and refuses to start if it does not match what it stored.
  const stub = (name, body) =>
    writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await stub(
    "awg",
    `case "$1" in
  genkey|genpsk) head -c 32 /dev/urandom | base64 ;;
  pubkey) sed 's/^/pub-/' ;;
  *) exit 0 ;;
esac`,
  );
  for (const name of ["ip", "iptables", "sysctl", "amneziawg-go", "awg-quick"]) {
    await stub(name, "exit 0");
  }
  for (const name of ["awg", "ip", "iptables", "sysctl", "amneziawg-go", "awg-quick"]) {
    await chmod(join(bin, name), 0o755);
  }

  // The geometry script lives at a fixed path inside the container; point the
  // entrypoint at the real one in this checkout.
  const geometry = fileURLToPath(
    new URL("../scripts/awg3-geometry.sh", import.meta.url),
  );
  const script = (await readFile(entrypointPath, "utf8"))
    .replace(/\r\n/g, "\n")
    .replace("/usr/local/libexec/awg3-geometry.sh", geometry);
  const localEntrypoint = join(root, "entrypoint.sh");
  await writeFile(localEntrypoint, script, { mode: 0o755 });

  // It ends in an idle loop, so it is stopped rather than waited for.
  const result = spawnSync(
    "sh",
    ["-c", `timeout 20 sh ${localEntrypoint}; true`],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AWG3_STATE_DIR: state,
      },
      encoding: "utf8",
    },
  );

  const config = await readFile(join(state, "awg0.conf"), "utf8").catch(
    () => "",
  );
  assert.ok(
    config.includes("[Interface]"),
    `no config was written.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );

  // Every key iOS needs, or it silently drops the whole AWG block.
  for (const key of ["Jc", "Jmin", "Jmax", "S1", "S2", "H1", "H2", "H3", "H4"]) {
    assert.match(config, new RegExp(`^${key} = \S+$`, "m"), `missing ${key}`);
  }
  assert.match(config, /^HeaderProtectionKey = \S+$/m);
  assert.match(config, /^RandomTrailers = on$/m);
  assert.match(config, /^ContentPaddingAddition = \d+-\d+$/m);

  // Written exactly once: the generator emits it, and the entrypoint used to
  // add a second copy, which left the tools and the node-agent disagreeing
  // about which one wins.
  const trailers = config.match(/^RandomTrailers = /gm) ?? [];
  assert.equal(trailers.length, 1, "RandomTrailers must appear once");

  // The interface MTU and the S4 budget must be the same number.
  const s4 = Number(/^S4 = (\d+)$/m.exec(config)?.[1]);
  const mtu = Number(
    /ip link set mtu "?\$?\{?(\d+)/.exec(script)?.[1] ?? "1420",
  );
  assert.ok(s4 >= 12, `S4=${s4}`);
  assert.ok(
    s4 + 32 + 1420 + 28 <= 1500,
    `S4=${s4} overflows the interface MTU budget`,
  );
  void mtu;
});

test("the entrypoint carries no variable the generator now owns", async () => {
  const script = (await readFile(entrypointPath, "utf8")).replace(/\r\n/g, "\n");

  // $h1..$h4 moved into the generator. A reference left behind here is an
  // unbound variable under `set -eu`, i.e. a container that never starts.
  assert.doesNotMatch(script, /\$h[1-4]\b/, "dangling header variable");
  // One MTU, used for the interface and for the S4 budget alike.
  assert.doesNotMatch(
    script,
    /ip link set mtu 1420/,
    "the interface MTU must come from the same variable as the budget",
  );
});

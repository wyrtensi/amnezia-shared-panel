import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
// A file URL pathname is "/C:/..." on Windows; bash needs "C:/...".
const scriptPath = new URL("../ensure-swap.sh", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
// Every path handed to the script becomes part of a grep ERE inside it, and a
// Windows backslash there is an escape, not a separator. Git Bash accepts
// "C:/Users/...", so normalise once, here.
const bashPath = (value) => value.replace(/\\/g, "/");

const KIB = 1024;

// One fixture host. Sizes are KiB, matching /proc/meminfo's own unit.
const host = async ({
  swapTotalKb = 0,
  swapFreeKb = 0,
  memAvailableKb = 400000,
  fileKb = 0,
  fileActive = false,
  freeKb = 6000000,
  swappiness = 10,
  fstabHasEntry = false,
} = {}) => {
  const dir = bashPath(await mkdtemp(path.join(tmpdir(), "ensure-swap-")));
  const swapfile = bashPath(path.join(dir, "swapfile"));
  if (fileKb > 0) {
    // Sparse: a real 2 GiB write would make the suite unusable.
    const handle = await open(swapfile, "w");
    await handle.truncate(fileKb * KIB);
    await handle.close();
  }
  const meminfo = bashPath(path.join(dir, "meminfo"));
  await writeFile(
    meminfo,
    `MemTotal:        983040 kB\nMemAvailable:    ${memAvailableKb} kB\n` +
      `SwapTotal:       ${swapTotalKb} kB\nSwapFree:        ${swapFreeKb} kB\n`,
  );
  const swaps = bashPath(path.join(dir, "swaps"));
  await writeFile(
    swaps,
    `Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n` +
      (fileActive ? `${swapfile} file\t\t${fileKb}\t\t0\t\t-2\n` : ""),
  );
  const fstab = bashPath(path.join(dir, "fstab"));
  await writeFile(
    fstab,
    fstabHasEntry ? `${swapfile} none swap sw 0 0\n` : "/dev/sda1 / ext4 defaults 0 1\n",
  );
  const sysctlConf = bashPath(path.join(dir, "99-swappiness.conf"));
  return {
    dir,
    swapfile,
    fstab,
    sysctlConf,
    env: {
      ...process.env,
      ENSURE_SWAP_SWAPFILE: swapfile,
      ENSURE_SWAP_MEMINFO: meminfo,
      ENSURE_SWAP_SWAPS: swaps,
      ENSURE_SWAP_FSTAB: fstab,
      ENSURE_SWAP_SYSCTL_CONF: sysctlConf,
      ENSURE_SWAP_FREE_KB: String(freeKb),
      ENSURE_SWAP_SWAPPINESS: String(swappiness),
    },
  };
};

const ensureSwap = async (fixture, ...args) => {
  try {
    const { stdout } = await run("bash", [scriptPath, ...args], { env: fixture.env });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.code, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
};

test("a 2 GiB swapfile that is active and persisted needs nothing", async () => {
  // mkswap keeps a header page, so a 2 GiB file reports 2 GiB - 4 KiB.
  const fixture = await host({
    swapTotalKb: 2097148,
    swapFreeKb: 2097148,
    fileKb: 2097152,
    fileActive: true,
    fstabHasEntry: true,
  });
  const { code, out } = await ensureSwap(fixture, "--check");
  assert.equal(code, 0);
  assert.match(out, /-> ok/);
});

test("a swap partition of 4 GiB is left alone and wants no /swapfile fstab entry", async () => {
  // Enough swap by any other means is enough: this must not create a file.
  const fixture = await host({ swapTotalKb: 4194304, swapFreeKb: 4194304 });
  const { code, out } = await ensureSwap(fixture, "--check");
  assert.equal(code, 0);
  assert.match(out, /-> ok/);
});

test("no swap at all, with room, asks to create", async () => {
  const fixture = await host({ freeKb: 6000000 });
  const { code, out } = await ensureSwap(fixture, "--check");
  assert.equal(code, 10);
  assert.match(out, /-> will create/);
});

test("no swap and too little disk is refused, naming the shortfall", async () => {
  // after = 5000000 - 2097152 = 2902848 KiB free, below the 3072 MiB reserve.
  const fixture = await host({ freeKb: 5000000 });
  const { code, out } = await ensureSwap(fixture, "--check");
  assert.equal(code, 2);
  assert.match(out, /refused/);
  assert.match(out, /237 MiB short/);
  assert.match(out, /docker image prune -a/);
});

test("a 1 GiB swapfile is grown when the freed blocks make it fit", async () => {
  // after = 4500000 + 1048576 - 2097152 = 3451424 KiB, above the reserve.
  const fixture = await host({
    swapTotalKb: 1048572,
    swapFreeKb: 1048572,
    fileKb: 1048576,
    fileActive: true,
    fstabHasEntry: true,
    freeKb: 4500000,
  });
  const { code, out } = await ensureSwap(fixture, "--check");
  assert.equal(code, 10);
  assert.match(out, /-> will grow/);
});

test("growing is refused when the freed blocks still do not make it fit", async () => {
  // after = 4000000 + 1048576 - 2097152 = 2951424 KiB, below the reserve.
  const fixture = await host({
    swapTotalKb: 1048572,
    swapFreeKb: 1048572,
    fileKb: 1048576,
    fileActive: true,
    fstabHasEntry: true,
    freeKb: 4000000,
  });
  const { code, out } = await ensureSwap(fixture, "--check");
  assert.equal(code, 2);
  assert.match(out, /refused/);
});

test("growing is refused when swapoff would not fit in RAM", async () => {
  // 948572 KiB paged out, 400000 KiB available: swapoff(2) would ENOMEM and
  // the operator would be left thinking the host had grown its swap.
  const fixture = await host({
    swapTotalKb: 1048572,
    swapFreeKb: 100000,
    memAvailableKb: 400000,
    fileKb: 1048576,
    fileActive: true,
    fstabHasEntry: true,
    freeKb: 4500000,
  });
  const { code, out } = await ensureSwap(fixture, "--check");
  assert.equal(code, 2);
  assert.match(out, /swapoff would fail/);
});

test("swap that is big enough but unpersisted still needs a change", async () => {
  const fixture = await host({
    swapTotalKb: 2097148,
    swapFreeKb: 2097148,
    fileKb: 2097152,
    fileActive: true,
    fstabHasEntry: false,
  });
  const { code, out } = await ensureSwap(fixture, "--check");
  assert.equal(code, 10);
  assert.match(out, /not persisted/);
});

test("a wrong swappiness alone needs a change", async () => {
  const fixture = await host({
    swapTotalKb: 2097148,
    swapFreeKb: 2097148,
    fileKb: 2097152,
    fileActive: true,
    fstabHasEntry: true,
    swappiness: 60,
  });
  const { code } = await ensureSwap(fixture, "--check");
  assert.equal(code, 10);
});

test("a reserve below the floor is a usage error, not a silent override", async () => {
  const fixture = await host({});
  const { code, out } = await ensureSwap(fixture, "--check", "--min-free-mib", "512");
  assert.equal(code, 2);
  assert.match(out, /--min-free-mib/);
});

test("a mode is required", async () => {
  const fixture = await host({});
  const { code } = await ensureSwap(fixture);
  assert.equal(code, 2);
});

// Overriding PATH for a Git Bash child means mixing Windows and POSIX PATH
// syntax, which Git Bash resolves inconsistently. CI is ubuntu-latest and runs
// these; on Windows the --check suite above is what a local run proves.
const stubsUnsupported =
  process.platform === "win32" && "stubbed PATH needs a POSIX shell environment";

// Stubs for every command that would touch the real host. Each logs its own
// name and arguments so the test can assert the ORDER of the dangerous ones.
const stubBin = async (fixture) => {
  const bin = bashPath(path.join(fixture.dir, "bin"));
  await mkdir(bin);
  const log = bashPath(path.join(fixture.dir, "calls.log"));
  const write = async (name, body) => {
    const file = path.join(bin, name);
    await writeFile(file, `#!/usr/bin/env bash\n${body}\n`);
    await chmod(file, 0o755);
  };
  const record = `printf '%s %s\\n' "$(basename "$0")" "$*" >> "${log}"`;
  for (const name of ["mkswap", "swapon", "swapoff", "sysctl", "dd"]) {
    await write(name, record);
  }
  // fallocate must also produce the file, or chmod/stat below have nothing.
  await write("fallocate", `${record}\n: > "\${@: -1}"`);
  fixture.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  fixture.log = log;
  return fixture;
};

const calls = async (fixture) => (await readFile(fixture.log, "utf8")).trim().split("\n");

test("--apply creates a swapfile without ever calling swapoff", { skip: stubsUnsupported }, async () => {
  // There is nothing to switch off, and a stray swapoff on a host that swaps to
  // a partition would take that partition down.
  const fixture = await stubBin(await host({ freeKb: 6000000, swappiness: 60 }));
  const { code } = await ensureSwap(fixture, "--apply");
  assert.equal(code, 0);
  const log = await calls(fixture);
  assert.ok(!log.some((line) => line.startsWith("swapoff")), log.join("\n"));
  assert.deepEqual(
    log.filter((line) => /^(fallocate|mkswap|swapon)/.test(line)).map((line) => line.split(" ")[0]),
    ["fallocate", "mkswap", "swapon"],
  );
});

test("--apply grows an existing swapfile in the only order that is safe", { skip: stubsUnsupported }, async () => {
  const fixture = await stubBin(
    await host({
      swapTotalKb: 1048572,
      swapFreeKb: 1048572,
      fileKb: 1048576,
      fileActive: true,
      fstabHasEntry: true,
      freeKb: 4500000,
    }),
  );
  const { code } = await ensureSwap(fixture, "--apply");
  assert.equal(code, 0);
  const order = (await calls(fixture))
    .filter((line) => /^(swapoff|fallocate|mkswap|swapon)/.test(line))
    .map((line) => line.split(" ")[0]);
  assert.deepEqual(order, ["swapoff", "fallocate", "mkswap", "swapon"]);
});

test("--apply is idempotent about /etc/fstab", { skip: stubsUnsupported }, async () => {
  const fixture = await stubBin(await host({ freeKb: 6000000 }));
  await ensureSwap(fixture, "--apply");
  await ensureSwap(fixture, "--apply");
  const fstab = await readFile(fixture.fstab, "utf8");
  const entries = fstab.split("\n").filter((line) => line.includes("swapfile"));
  assert.equal(entries.length, 1, fstab);
  assert.match(entries[0], /none swap sw 0 0$/);
});

test("--apply pins swappiness on disk, not just for this boot", { skip: stubsUnsupported }, async () => {
  const fixture = await stubBin(await host({ freeKb: 6000000, swappiness: 60 }));
  await ensureSwap(fixture, "--apply");
  assert.equal(await readFile(fixture.sysctlConf, "utf8"), "vm.swappiness=10\n");
  assert.ok((await calls(fixture)).some((line) => line === "sysctl -q -w vm.swappiness=10"));
});

test("--apply leaves the swapfile unreadable to everyone but root", { skip: stubsUnsupported }, async () => {
  // The swapfile holds whatever the panel had in memory, keys included.
  const fixture = await stubBin(await host({ freeKb: 6000000 }));
  await ensureSwap(fixture, "--apply");
  assert.equal((await stat(fixture.swapfile)).mode & 0o777, 0o600);
});

test("--apply on a host that only needs persistence touches no swap command", { skip: stubsUnsupported }, async () => {
  const fixture = await stubBin(
    await host({
      swapTotalKb: 2097148,
      swapFreeKb: 2097148,
      fileKb: 2097152,
      fileActive: true,
      fstabHasEntry: false,
    }),
  );
  const { code } = await ensureSwap(fixture, "--apply");
  assert.equal(code, 0);
  const log = await calls(fixture);
  assert.ok(!log.some((line) => /^(swapoff|fallocate|mkswap|swapon)/.test(line)), log.join("\n"));
  assert.match(await readFile(fixture.fstab, "utf8"), /swapfile none swap sw 0 0/);
});

test("--apply refuses exactly where --check refuses", { skip: stubsUnsupported }, async () => {
  const fixture = await stubBin(await host({ freeKb: 5000000 }));
  const { code } = await ensureSwap(fixture, "--apply");
  assert.equal(code, 2);
  // Refusing after having already run swapoff would be the worst outcome: no
  // log file at all is the proof that nothing ran.
  await assert.rejects(() => readFile(fixture.log, "utf8"));
});

test("the docs point at the script instead of repeating its commands", async () => {
  // Two places describing the same mkswap sequence is how a production host
  // ended up disagreeing with the docs in the first place.
  const read = async (relative) =>
    readFile(new URL(`../../${relative}`, import.meta.url), "utf8");
  const smallHosts = await read("docs/SMALL-HOSTS.md");
  assert.match(smallHosts, /scripts\/ensure-swap\.sh --check/);
  assert.match(smallHosts, /scripts\/ensure-swap\.sh --apply/);
  for (const doc of ["docs/INSTALL.md", "docs/ROLLOUT.md", "infra/node/CHECKLIST.md"]) {
    assert.match(await read(doc), /ensure-swap\.sh/, `${doc} does not mention the script`);
  }
  // The CI infra job must actually run this suite.
  assert.match(await read(".github/workflows/ci.yml"), /scripts\/tests\/\*\.mjs/);
});

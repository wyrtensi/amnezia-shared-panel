import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../install-frps.sh", import.meta.url));
const frpcPath = fileURLToPath(new URL("../../node/scripts/install-frpc.sh", import.meta.url));
const executing = { skip: process.platform === "linux" ? false : "needs a POSIX shell" };

const BRIDGE = "3f1c2a40-7b6d-4d2e-8a11-0c9e5b7d1a22";
const OTHER_BRIDGE = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const TOKEN_VALUE = "bridge-token-value-abcdef123456";
const args = [
  "--bridge-id", BRIDGE,
  "--control-port", "7000",
  "--udp-start", "41000",
  "--udp-end", "41031",
];

const write = async (path, body, mode) => {
  await writeFile(path, body);
  await chmod(path, mode);
};

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "install-frps-"));
  const bin = join(root, "bin");
  const etc = join(root, "etc");
  const frp = join(etc, "amnezia-bridge", "frp");
  const sc = join(root, "systemctl");
  const prefix = join(root, "opt");
  const systemd = join(root, "systemd");
  const state = join(root, "state");
  for (const dir of [bin, frp, sc, join(prefix, "0.72.0"), state]) await mkdir(dir, { recursive: true });
  await write(join(frp, "token"), `${TOKEN_VALUE}\n`, 0o600);
  await write(join(frp, "server.key"), "KEY\n", 0o600);
  await write(join(frp, "server.crt"), "CRT\n", 0o644);
  await write(join(state, "verify-rc"), "0", 0o644);
  await write(join(state, "ss-tcp-extra"), "", 0o644);
  await write(join(state, "ss-udp"), "", 0o644);

  await write(
    join(bin, "systemctl"),
    `#!/bin/sh
echo "systemctl $*" >>"$STATE/calls"
SC="$STATE/../systemctl"
cmd="$1"; shift
args=""
for a in "$@"; do case "$a" in --*) ;; *) args="$a" ;; esac; done
case "$cmd" in
  is-active) [ -f "$SC/active.$args" ] ;;
  is-enabled) [ -f "$SC/enabled.$args" ] ;;
  enable) touch "$SC/enabled.$args"; case "$*" in *--now*) [ ! -f "$STATE/start-fails" ] || exit 1; touch "$SC/active.$args" ;; esac ;;
  restart) [ ! -f "$STATE/start-fails" ] || exit 1; touch "$SC/active.$args" ;;
  disable) rm -f "$SC/enabled.$args"; case "$*" in *--now*) rm -f "$SC/active.$args" ;; esac ;;
  daemon-reload) ;;
  *) echo "unexpected systemctl $cmd" >&2; exit 99 ;;
esac
`,
    0o755,
  );
  // frps only listens once its unit is active, like the real thing.
  await write(
    join(bin, "ss"),
    `#!/bin/sh
case "$*" in
  *-ltn*)
    cat "$STATE/ss-tcp-extra"
    n=$(($(cat "$STATE/ss-count" 2>/dev/null || echo 0) + 1)); echo "$n" >"$STATE/ss-count"
    after="$(cat "$STATE/listen-after" 2>/dev/null || echo 0)"
    if [ -f "$STATE/../systemctl/active.amnezia-frps.service" ] && [ ! -f "$STATE/no-listen" ] && [ "$n" -ge "$after" ]; then
      echo "LISTEN 0 4096 0.0.0.0:$(cat "$STATE/control-port") 0.0.0.0:*"
      echo "LISTEN 0 4096 127.0.0.1:7500 0.0.0.0:*"
    fi ;;
  *-lun*) cat "$STATE/ss-udp" ;;
esac
`,
    0o755,
  );
  await write(join(state, "control-port"), "7000", 0o644);
  await write(
    join(bin, "curl"),
    `#!/bin/sh
out=""; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; http*) url="$1"; shift ;; *) shift ;; esac
done
echo "$url" >>"$STATE/curl-urls"
printf 'not a frp archive' >"$out"
`,
    0o755,
  );
  // The real frps renders {{ .Envs.X }} at verify time, so the stub insists on them.
  await write(
    join(prefix, "0.72.0", "frps"),
    `#!/bin/sh
case "$1" in
  --version) echo 0.72.0 ;;
  verify)
    [ -n "\${FRPS_DASHBOARD_USER:-}" ] && [ -n "\${FRPS_DASHBOARD_PASSWORD:-}" ] || exit 7
    exit "$(cat "$STATE/verify-rc")" ;;
esac
`,
    0o755,
  );

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STATE: state,
    AMNEZIA_ETC: etc,
    AMNEZIA_SYSTEMD_DIR: systemd,
    AMNEZIA_FRP_PREFIX: prefix,
    AMNEZIA_ALLOW_NONROOT: "1",
    AMNEZIA_LISTEN_WAIT: "3",
  };
  const run = (...a) => spawnSync("sh", [scriptPath, ...a], { env, encoding: "utf8" });
  return {
    root, etc, frp, sc, prefix, systemd, state, run,
    conf: join(frp, "frps.toml"),
    readConf: () => readFile(join(frp, "frps.toml"), "utf8"),
    calls: () => readFile(join(state, "calls"), "utf8").catch(() => ""),
    flag: (name, content = "1") => writeFile(join(state, name), content),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const withHost = (name, fn) =>
  test(name, executing, async () => {
    const host = await fixture();
    try {
      await fn(host);
    } finally {
      await host.cleanup();
    }
  });

withHost("installs one frps with token auth, forced TLS, the UDP pool and a loopback dashboard", async (h) => {
  const r = h.run(...args);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const conf = await h.readConf();
  assert.match(conf, /^bindPort = 7000$/m);
  assert.match(conf, /^auth\.method = "token"$/m);
  assert.match(conf, /^auth\.tokenSource\.file\.path = ".*amnezia-bridge\/frp\/token"$/m);
  assert.match(conf, /^transport\.tls\.force = true$/m);
  assert.match(conf, /^transport\.tls\.certFile = ".*server\.crt"$/m);
  assert.match(conf, /^transport\.tls\.keyFile = ".*server\.key"$/m);
  assert.match(conf, /^webServer\.addr = "127\.0\.0\.1"$/m);
  assert.match(conf, /^webServer\.port = 7500$/m);
  assert.match(conf, /^\[\[allowPorts\]\]\nstart = 41000\nend = 41031$/m);
  assert.ok(!conf.includes(TOKEN_VALUE));

  const env = await readFile(join(h.frp, "dashboard.env"), "utf8");
  const password = /^FRPS_DASHBOARD_PASSWORD=(.+)$/m.exec(env)?.[1];
  assert.match(password ?? "", /^[A-Za-z0-9]{32}$/);
  assert.equal((await stat(join(h.frp, "dashboard.env"))).mode & 0o777, 0o600);
  assert.ok(!conf.includes(password));
  assert.ok(!(r.stdout + r.stderr).includes(password));
  assert.ok(!(r.stdout + r.stderr).includes(TOKEN_VALUE));

  const unit = await readFile(join(h.systemd, "amnezia-frps.service"), "utf8");
  assert.match(unit, /EnvironmentFile=.*dashboard\.env/);
  assert.match(unit, /ExecStart=.*\/0\.72\.0\/frps -c .*frps\.toml/);
  assert.match(await h.calls(), /systemctl enable --now amnezia-frps\.service/);
  assert.equal((await readFile(join(h.frp, "bridge-id"), "utf8")).trim(), BRIDGE);
  assert.match(r.stdout, /TCP 7000: allow only the trusted node source addresses/);
  assert.match(r.stdout, /UDP 41000-41031: open to VPN clients/);
});

withHost("a dry run reports the plan and firewall rules and writes nothing", async (h) => {
  const r = h.run(...args, "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PLAN: write .*frps\.toml/);
  assert.match(r.stdout, /PLAN: generate dashboard credentials/);
  assert.match(r.stdout, /PLAN: enable and start amnezia-frps\.service/);
  assert.match(r.stdout, /UDP 41000-41031/);
  assert.deepEqual((await readdir(h.frp)).sort(), ["server.crt", "server.key", "token"]);
  await assert.rejects(stat(h.systemd));
  assert.doesNotMatch(await h.calls(), /systemctl (enable|restart|daemon-reload|disable)/);
});

withHost("a repeat with the same inputs is a no-op that keeps the credentials", async (h) => {
  assert.equal(h.run(...args).status, 0);
  const credentials = await readFile(join(h.frp, "dashboard.env"), "utf8");
  const conf = await h.readConf();
  const before = await h.calls();
  const again = h.run(...args);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /no change/);
  assert.equal(await readFile(join(h.frp, "dashboard.env"), "utf8"), credentials);
  assert.equal(await h.readConf(), conf);
  assert.doesNotMatch((await h.calls()).slice(before.length), /systemctl (enable|restart|disable)/);
});

withHost("conflicts with an existing install name the field", async (h) => {
  assert.equal(h.run(...args).status, 0);
  const other = h.run("--bridge-id", OTHER_BRIDGE, "--control-port", "7000", "--udp-start", "41000", "--udp-end", "41031");
  assert.equal(other.status, 20);
  assert.match(other.stderr, new RegExp(`--bridge-id ${OTHER_BRIDGE}`));
  const control = h.run("--bridge-id", BRIDGE, "--control-port", "7001", "--udp-start", "41000", "--udp-end", "41031");
  assert.equal(control.status, 20);
  assert.match(control.stderr, /bindPort=7000.*--control-port 7001/);
  const pool = h.run("--bridge-id", BRIDGE, "--control-port", "7000", "--udp-start", "41000", "--udp-end", "41063");
  assert.equal(pool.status, 20);
  assert.match(pool.stderr, /end=41031.*--udp-end 41063/);
});

withHost("ports already bound by other processes stop a first install", async (h) => {
  await h.flag("ss-tcp-extra", "LISTEN 0 4096 0.0.0.0:7000 0.0.0.0:*\n");
  const tcp = h.run(...args);
  assert.equal(tcp.status, 21);
  assert.match(tcp.stderr, /--control-port/);
  await h.flag("ss-tcp-extra", "");
  await h.flag("ss-udp", "UNCONN 0 0 0.0.0.0:41005 0.0.0.0:*\n");
  const udp = h.run(...args);
  assert.equal(udp.status, 21);
  assert.match(udp.stderr, /41005/);
  await assert.rejects(stat(h.conf));
});

withHost("invalid arguments exit 2", async (h) => {
  const bad = [
    [],
    ["--bridge-id", "x", "--control-port", "7000", "--udp-start", "41000", "--udp-end", "41031"],
    ["--bridge-id", BRIDGE, "--control-port", "7000", "--udp-start", "41031", "--udp-end", "41000"],
    ["--bridge-id", BRIDGE, "--control-port", "7000", "--udp-start", "41000", "--udp-end", "99999"],
    ["--bridge-id", BRIDGE, "--control-port", "7500", "--udp-start", "41000", "--udp-end", "41031"],
    ["--bridge-id", BRIDGE, "--control-port", "abc", "--udp-start", "41000", "--udp-end", "41031"],
    [...args, "--token", "x"],
  ];
  for (const a of bad) {
    const r = h.run(...a);
    assert.equal(r.status, 2, `${a.join(" ")}: ${r.stderr}`);
  }
});

withHost("missing or loose protected files are refused", async (h) => {
  await chmod(join(h.frp, "server.key"), 0o640);
  const loose = h.run(...args);
  assert.equal(loose.status, 11);
  assert.match(loose.stderr, /server\.key has mode 640/);
  await chmod(join(h.frp, "server.key"), 0o600);
  await rm(join(h.frp, "token"));
  assert.equal(h.run(...args).status, 11);
});

withHost("a download that fails the pinned checksum installs nothing", async (h) => {
  await rm(join(h.prefix, "0.72.0", "frps"));
  const r = h.run(...args);
  assert.equal(r.status, 12);
  assert.match(r.stderr, /SHA-256 mismatch/);
  assert.match(
    await readFile(join(h.state, "curl-urls"), "utf8"),
    /^https:\/\/github\.com\/fatedier\/frp\/releases\/download\/v0\.72\.0\/frp_0\.72\.0_linux_(amd64|arm64)\.tar\.gz$/m,
  );
  await assert.rejects(stat(join(h.prefix, "0.72.0", "frps")));
  await assert.rejects(stat(h.conf));
  await assert.rejects(stat(join(h.frp, "dashboard.env")));
});

withHost("a failed frps verify keeps the previous config and unit", async (h) => {
  assert.equal(h.run(...args).status, 0);
  const old = `${await h.readConf()}# operator note\n`;
  await writeFile(h.conf, old);
  await h.flag("verify-rc", "1");
  const before = await h.calls();
  const r = h.run(...args);
  assert.equal(r.status, 13);
  assert.equal(await h.readConf(), old);
  assert.deepEqual((await readdir(h.frp)).sort(), ["bridge-id", "dashboard.env", "frps.toml", "server.crt", "server.key", "token"]);
  assert.doesNotMatch((await h.calls()).slice(before.length), /systemctl (enable|restart|disable)/);
});

withHost("a failed start of a new install is rolled back", async (h) => {
  await h.flag("start-fails");
  const r = h.run(...args);
  assert.equal(r.status, 50);
  await assert.rejects(stat(h.conf));
  assert.match(await h.calls(), /systemctl disable --now amnezia-frps\.service/);

  await rm(join(h.state, "start-fails"));
  await h.flag("no-listen");
  const silent = h.run(...args);
  assert.equal(silent.status, 50);
  assert.match(silent.stderr, /nothing listens on tcp 7000/);
  await assert.rejects(stat(h.conf));
});

withHost("a listener that appears on a later poll is not a failure", async (h) => {
  // Calls: 1 = pre-start listing, 2 = first poll (nothing yet), 3 = second poll.
  await h.flag("listen-after", "3");
  const r = h.run(...args);
  assert.equal(r.status, 0, r.stderr);
  assert.match(await h.calls(), /systemctl enable --now amnezia-frps\.service/);
  assert.doesNotMatch(await h.calls(), /systemctl disable/);
});

withHost("verify output is shown on exit 13", async (h) => {
  await h.flag("verify-rc", "1");
  const r = h.run(...args);
  assert.equal(r.status, 13);
  assert.match(r.stderr, /frps verify rejected/);
});

withHost("an unprotected existing dashboard.env is not sourced", async (h) => {
  await write(join(h.frp, "dashboard.env"), "FRPS_DASHBOARD_USER=a\nFRPS_DASHBOARD_PASSWORD=b\n", 0o644);
  const r = h.run(...args);
  assert.equal(r.status, 11);
  assert.match(r.stderr, /dashboard\.env has mode 644/);
});

withHost("rollback does not restart a unit that was inactive before", async (h) => {
  assert.equal(h.run(...args).status, 0);
  await rm(join(h.sc, "active.amnezia-frps.service"));
  await writeFile(h.conf, `${await h.readConf()}# operator note\n`);
  await h.flag("no-listen");
  const before = await h.calls();
  const r = h.run(...args);
  assert.equal(r.status, 50);
  const added = (await h.calls()).slice(before.length);
  assert.doesNotMatch(added, /systemctl restart/);
  assert.match(added, /systemctl stop amnezia-frps\.service/);
});

test("both installers pin the same frp release with the official digests", executing, async () => {
  const [frps, frpc] = await Promise.all([readFile(scriptPath, "utf8"), readFile(frpcPath, "utf8")]);
  const block = (text, name) => new RegExp(`# BEGIN ${name}.*?# END ${name}\\n`, "s").exec(text)?.[0];
  for (const name of ["frp-pin", "frp-fetch"]) {
    assert.ok(block(frps, name), `${name} block in frps`);
    assert.equal(block(frps, name), block(frpc, name), `${name} must be identical`);
  }
  const pin = block(frps, "frp-pin");
  assert.match(pin, /FRP_VERSION=0\.72\.0/);
  // frp_sha256_checksums.txt of release v0.72.0.
  assert.match(pin, /FRP_SHA256_AMD64=daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804/);
  assert.match(pin, /FRP_SHA256_ARM64=02180b857480302fd934e9ddbd50fe2f73229f99062f88756abc6de9df5e95cf/);
});

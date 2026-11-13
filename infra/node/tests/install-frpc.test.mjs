import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../scripts/install-frpc.sh", import.meta.url));
const executing = { skip: process.platform === "linux" ? false : "needs a POSIX shell" };

const ROUTE = "0b6f9a52-3c1d-4e7a-9b88-1f2a3c4d5e6f";
const OTHER_ROUTE = "7c1e2d3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5";
const TOKEN_VALUE = "super-secret-token-value-123456";
const baseArgs = [
  "--route-id", ROUTE,
  "--bridge-ip", "203.0.113.10",
  "--control-port", "7000",
  "--public-port", "41000",
];

const write = async (path, body, mode) => {
  await writeFile(path, body);
  await chmod(path, mode);
};

/** A host with PATH shims for docker, systemctl, journalctl, nc and curl. */
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "install-frpc-"));
  const bin = join(root, "bin");
  const etc = join(root, "etc");
  const sc = join(root, "systemctl");
  const prefix = join(root, "opt");
  const systemd = join(root, "systemd");
  const state = join(root, "state");
  for (const dir of [bin, join(etc, "amnezia-node", "frp"), sc, join(prefix, "0.72.0"), state]) {
    await mkdir(dir, { recursive: true });
  }
  await write(join(etc, "amnezia-node", "frp", "token"), `${TOKEN_VALUE}\n`, 0o600);
  await write(join(etc, "amnezia-node", "frp", "ca.crt"), "CA\n", 0o644);
  await write(join(state, "docker-port"), "51890/udp -> 0.0.0.0:51890\n51890/udp -> [::]:51890\n", 0o644);
  await write(join(state, "health"), "running healthy\n", 0o644);
  await write(join(state, "journal"), "login to server success\n[awg] start proxy success\n", 0o644);
  await write(join(state, "verify-rc"), "0", 0o644);

  await write(
    join(bin, "docker"),
    `#!/bin/sh
echo "docker $*" >>"$STATE/calls"
case "$1" in
  port) [ -f "$STATE/docker-port" ] || exit 1; cat "$STATE/docker-port" ;;
  inspect) cat "$STATE/health" ;;
  *) echo "unexpected docker $*" >&2; exit 99 ;;
esac
`,
    0o755,
  );
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
  stop) rm -f "$SC/active.$args" ;;
  disable) rm -f "$SC/enabled.$args"; case "$*" in *--now*) rm -f "$SC/active.$args" ;; esac ;;
  list-units) ;;
  daemon-reload) ;;
  *) echo "unexpected systemctl $cmd" >&2; exit 99 ;;
esac
`,
    0o755,
  );
  await write(join(bin, "journalctl"), `#!/bin/sh\ncat "$STATE/journal"\n`, 0o755);
  await write(join(bin, "nc"), `#!/bin/sh\n[ ! -f "$STATE/nc-fails" ]\n`, 0o755);
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
  const frpc = `#!/bin/sh
case "$1" in
  --version) echo 0.72.0 ;;
  verify) exit "$(cat "$STATE/verify-rc")" ;;
esac
`;
  await write(join(prefix, "0.72.0", "frpc"), frpc, 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STATE: state,
    AMNEZIA_ETC: etc,
    AMNEZIA_SYSTEMD_DIR: systemd,
    AMNEZIA_FRP_PREFIX: prefix,
    AMNEZIA_ALLOW_NONROOT: "1",
    AMNEZIA_REGISTER_WAIT: "2",
  };
  const run = (...args) => spawnSync("sh", [scriptPath, ...args], { env, encoding: "utf8" });
  const conf = (route = ROUTE) => join(etc, "amnezia-node", "frpc", `${route}.toml`);
  const readConf = (route = ROUTE) => readFile(conf(route), "utf8");
  const calls = async () => readFile(join(state, "calls"), "utf8").catch(() => "");
  const flag = (name, content = "1") => writeFile(join(state, name), content);
  return {
    root, etc, sc, prefix, systemd, state, run, conf, readConf, calls, flag,
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

withHost("wildcard publication installs a secret-free per-route config and unit", async (h) => {
  const r = h.run(...baseArgs);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const conf = await h.readConf();
  assert.match(conf, /^serverAddr = "203\.0\.113\.10"$/m);
  assert.match(conf, /^serverPort = 7000$/m);
  assert.match(conf, /^auth\.tokenSource\.file\.path = ".*amnezia-node\/frp\/token"$/m);
  assert.match(conf, /^transport\.tls\.enable = true$/m);
  assert.match(conf, /^transport\.tls\.trustedCaFile = ".*ca\.crt"$/m);
  assert.match(conf, /^transport\.tls\.serverName = "203\.0\.113\.10"$/m);
  assert.match(conf, new RegExp(`^name = "awg-route-${ROUTE}"$`, "m"));
  assert.match(conf, /^type = "udp"$/m);
  assert.match(conf, /^localIP = "127\.0\.0\.1"$/m);
  assert.match(conf, /^localPort = 51890$/m);
  assert.match(conf, /^remotePort = 41000$/m);
  assert.doesNotMatch(conf, /webServer/);
  assert.ok(!conf.includes(TOKEN_VALUE));
  assert.ok(!(r.stdout + r.stderr).includes(TOKEN_VALUE));
  const template = await readFile(join(h.systemd, "amnezia-frpc@.service"), "utf8");
  assert.match(template, /ExecStart=.*\/0\.72\.0\/frpc -c .*\/%i\.toml/);
  const calls = await h.calls();
  assert.match(calls, new RegExp(`systemctl enable --now amnezia-frpc@${ROUTE}.service`));
  assert.doesNotMatch(calls, /systemctl \S+ .*(awg|node-agent)/);
  assert.doesNotMatch(calls, /docker (restart|stop|rm|kill|start)/);
  const mode = (await stat(h.conf())).mode & 0o777;
  assert.equal(mode, 0o644);
});

withHost("a remapped host port becomes the local port", async (h) => {
  await h.flag("docker-port", "51890/udp -> 0.0.0.0:52000\n");
  const r = h.run(...baseArgs);
  assert.equal(r.status, 0, r.stderr);
  assert.match(await h.readConf(), /^localPort = 52000$/m);
  assert.match(r.stdout, /127\.0\.0\.1:52000/);
});

withHost("a loopback publication uses that loopback address", async (h) => {
  await h.flag("docker-port", "51890/udp -> 127.0.0.1:51890\n");
  const r = h.run(...baseArgs);
  assert.equal(r.status, 0, r.stderr);
  assert.match(await h.readConf(), /^localIP = "127\.0\.0\.1"$/m);
});

withHost("a specific IPv4 bind needs a matching --local-ip", async (h) => {
  await h.flag("docker-port", "51890/udp -> 10.0.0.5:51890\n");
  const missing = h.run(...baseArgs);
  assert.equal(missing.status, 33);
  assert.match(missing.stderr, /--local-ip 10\.0\.0\.5/);
  const wrong = h.run(...baseArgs, "--local-ip", "10.0.0.6");
  assert.equal(wrong.status, 33);
  assert.match(wrong.stderr, /--local-ip/);
  await assert.rejects(stat(h.conf()));
  const ok = h.run(...baseArgs, "--local-ip", "10.0.0.5");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(await h.readConf(), /^localIP = "10\.0\.0\.5"$/m);
});

withHost("missing, IPv6-only and ambiguous publications stop with the observation", async (h) => {
  await rm(join(h.state, "docker-port"));
  const absent = h.run(...baseArgs);
  assert.equal(absent.status, 30);
  assert.match(absent.stderr, /amnezia-awg3/);

  await h.flag("docker-port", "8080/tcp -> 0.0.0.0:8080\n");
  const noUdp = h.run(...baseArgs);
  assert.equal(noUdp.status, 30);
  assert.match(noUdp.stderr, /8080\/tcp/);

  await h.flag("docker-port", "51890/udp -> [::]:51890\n");
  const v6 = h.run(...baseArgs);
  assert.equal(v6.status, 32);
  assert.match(v6.stderr, /IPv6 only/);

  await h.flag("docker-port", "51890/udp -> 0.0.0.0:51890\n51890/udp -> 10.0.0.5:51890\n");
  const many = h.run(...baseArgs);
  assert.equal(many.status, 31);
  assert.match(many.stderr, /0\.0\.0\.0:51890/);
  await assert.rejects(stat(h.conf()));
});

withHost("overrides are checked against the observed mapping", async (h) => {
  const port = h.run(...baseArgs, "--local-udp-port", "51999");
  assert.equal(port.status, 33);
  assert.match(port.stderr, /--local-udp-port is 51999.*51890/);
  const ip = h.run(...baseArgs, "--local-ip", "127.0.0.2");
  assert.equal(ip.status, 33);
  assert.match(ip.stderr, /--local-ip/);
  const same = h.run(...baseArgs, "--local-udp-port", "51890", "--local-ip", "127.0.0.1");
  assert.equal(same.status, 0, same.stderr);
});

withHost("an unhealthy AWG container stops setup", async (h) => {
  await h.flag("health", "running unhealthy\n");
  const r = h.run(...baseArgs);
  assert.equal(r.status, 34);
  assert.match(r.stderr, /unhealthy/);
});

withHost("a dry run lists the plan and writes nothing", async (h) => {
  const r = h.run(...baseArgs, "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PLAN: write .*\.toml/);
  assert.match(r.stdout, /PLAN: enable and start amnezia-frpc@/);
  assert.match(r.stdout, /127\.0\.0\.1:51890/);
  await assert.rejects(stat(join(h.etc, "amnezia-node", "frpc")));
  await assert.rejects(stat(h.systemd));
  assert.doesNotMatch(await h.calls(), /systemctl (enable|restart|daemon-reload|stop|disable)/);
  // A dry run still reports a validation problem the real run would hit.
  await h.flag("docker-port", "51890/udp -> [::]:51890\n");
  assert.equal(h.run(...baseArgs, "--dry-run").status, 32);
});

withHost("repeating the same setup succeeds without a new route or restart", async (h) => {
  assert.equal(h.run(...baseArgs).status, 0);
  const before = await h.readConf();
  const callsBefore = await h.calls();
  const again = h.run(...baseArgs);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /no change/);
  assert.equal(await h.readConf(), before);
  const added = (await h.calls()).slice(callsBefore.length);
  assert.doesNotMatch(added, /systemctl (enable|restart|stop|disable)/);
  assert.deepEqual((await readdir(join(h.etc, "amnezia-node", "frpc"))).sort(), [`${ROUTE}.toml`]);
});

withHost("a conflicting existing config stops with the conflicting field", async (h) => {
  assert.equal(h.run(...baseArgs).status, 0);
  const before = await h.readConf();
  const r = h.run(
    "--route-id", ROUTE, "--bridge-ip", "203.0.113.10", "--control-port", "7000", "--public-port", "41001",
  );
  assert.equal(r.status, 20);
  assert.match(r.stderr, /remotePort=41000.*--public-port 41001/);
  assert.equal(await h.readConf(), before);
  const ip = h.run(
    "--route-id", ROUTE, "--bridge-ip", "203.0.113.11", "--control-port", "7000", "--public-port", "41000",
  );
  assert.equal(ip.status, 20);
  assert.match(ip.stderr, /serverAddr/);
});

withHost("a port held by another route on the same bridge is refused", async (h) => {
  assert.equal(h.run(...baseArgs).status, 0);
  const r = h.run(
    "--route-id", OTHER_ROUTE, "--bridge-ip", "203.0.113.10", "--control-port", "7000", "--public-port", "41000",
  );
  assert.equal(r.status, 21);
  assert.match(r.stderr, new RegExp(`--public-port 41000.*${ROUTE}`));
  await assert.rejects(stat(h.conf(OTHER_ROUTE)));
  // The same port on another bridge is a different endpoint.
  const other = h.run(
    "--route-id", OTHER_ROUTE, "--bridge-ip", "203.0.113.99", "--control-port", "7000", "--public-port", "41000",
  );
  assert.equal(other.status, 0, other.stderr);
});

withHost("invalid arguments exit 2 before touching anything", async (h) => {
  const bad = [
    [],
    baseArgs.slice(2),
    ["--route-id", "not-a-uuid", ...baseArgs.slice(2)],
    ["--route-id", ROUTE, "--bridge-ip", "999.1.1.1", "--control-port", "7000", "--public-port", "41000"],
    ["--route-id", ROUTE, "--bridge-ip", "203.0.113.10", "--control-port", "70000", "--public-port", "41000"],
    ["--route-id", ROUTE, "--bridge-ip", "203.0.113.10", "--control-port", "7000", "--public-port", "0"],
    [...baseArgs, "--bogus"],
    [...baseArgs, "--local-udp-port"],
    [...baseArgs, "--local-ip", "x"],
    ["--remove", "--route-id", ROUTE, "--public-port", "41000"],
  ];
  for (const args of bad) {
    const r = h.run(...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
  }
  assert.equal(await h.calls(), "");
});

withHost("missing or loose protected files are refused", async (h) => {
  const token = join(h.etc, "amnezia-node", "frp", "token");
  await chmod(token, 0o644);
  const loose = h.run(...baseArgs);
  assert.equal(loose.status, 11);
  assert.match(loose.stderr, /mode 644/);
  assert.ok(!loose.stderr.includes(TOKEN_VALUE));
  await rm(token);
  assert.equal(h.run(...baseArgs).status, 11);
});

withHost("a download that fails the pinned checksum installs nothing", async (h) => {
  await rm(join(h.prefix, "0.72.0", "frpc"));
  const r = h.run(...baseArgs);
  assert.equal(r.status, 12);
  assert.match(r.stderr, /SHA-256 mismatch/);
  const urls = await readFile(join(h.state, "curl-urls"), "utf8");
  assert.match(
    urls,
    /^https:\/\/github\.com\/fatedier\/frp\/releases\/download\/v0\.72\.0\/frp_0\.72\.0_linux_(amd64|arm64)\.tar\.gz$/m,
  );
  await assert.rejects(stat(join(h.prefix, "0.72.0", "frpc")));
  await assert.rejects(stat(h.conf()));
  assert.doesNotMatch(await h.calls(), /systemctl enable/);
});

withHost("a failed frpc verify leaves the previous config and unit untouched", async (h) => {
  assert.equal(h.run(...baseArgs).status, 0);
  // Same fields but a different text, so the script would rewrite it.
  const old = `${await h.readConf()}# operator note\n`;
  await writeFile(h.conf(), old);
  await h.flag("verify-rc", "1");
  const callsBefore = await h.calls();
  const r = h.run(...baseArgs);
  assert.equal(r.status, 13);
  assert.equal(await h.readConf(), old);
  assert.deepEqual(
    (await readdir(join(h.etc, "amnezia-node", "frpc"))).sort(),
    [`${ROUTE}.toml`],
  );
  assert.doesNotMatch((await h.calls()).slice(callsBefore.length), /systemctl (enable|restart|stop|disable)/);
});

withHost("frp authentication and TLS failures roll back a new route", async (h) => {
  await h.flag("journal", "login to the server failed: token in login doesn't match token from configuration\n");
  const auth = h.run(...baseArgs);
  assert.equal(auth.status, 41);
  assert.match(auth.stderr, /authentication or TLS/);
  await assert.rejects(stat(h.conf()));
  assert.match(await h.calls(), /systemctl disable --now amnezia-frpc@/);

  await h.flag("journal", "x509: certificate is valid for 1.2.3.4, not 203.0.113.10\n");
  assert.equal(h.run(...baseArgs).status, 41);
});

withHost("UDP registration refusal, unreachable control port and start failure are distinct", async (h) => {
  await h.flag("journal", "[awg] start error: port not allowed\n");
  const udp = h.run(...baseArgs);
  assert.equal(udp.status, 42);
  assert.match(udp.stderr, /41000/);
  await assert.rejects(stat(h.conf()));

  await h.flag("journal", "");
  const silent = h.run(...baseArgs);
  assert.equal(silent.status, 50);

  await h.flag("nc-fails");
  const tcp = h.run(...baseArgs);
  assert.equal(tcp.status, 40);
  assert.match(tcp.stderr, /203\.0\.113\.10:7000/);
  await rm(join(h.state, "nc-fails"));

  await h.flag("start-fails");
  const start = h.run(...baseArgs);
  assert.equal(start.status, 50);
  await assert.rejects(stat(h.conf()));
});

withHost("remove stops only that unit and deletes its config", async (h) => {
  assert.equal(h.run(...baseArgs).status, 0);
  assert.equal(
    h.run("--route-id", OTHER_ROUTE, "--bridge-ip", "203.0.113.10", "--control-port", "7000", "--public-port", "41001").status,
    0,
  );
  const dry = h.run("--remove", "--route-id", ROUTE, "--dry-run");
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /PLAN: stop and disable/);
  await stat(h.conf());
  const callsBefore = await h.calls();

  const r = h.run("--remove", "--route-id", ROUTE);
  assert.equal(r.status, 0, r.stderr);
  await assert.rejects(stat(h.conf()));
  await stat(h.conf(OTHER_ROUTE));
  const added = (await h.calls()).slice(callsBefore.length);
  assert.match(added, new RegExp(`systemctl stop amnezia-frpc@${ROUTE}.service`));
  assert.doesNotMatch(added, new RegExp(OTHER_ROUTE));
  await stat(join(h.systemd, "amnezia-frpc@.service"));

  const again = h.run("--remove", "--route-id", ROUTE);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /nothing to remove/);
});

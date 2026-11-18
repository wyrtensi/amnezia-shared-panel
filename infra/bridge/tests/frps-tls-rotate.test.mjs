import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../frps-tls-rotate.sh", import.meta.url));
const linux = { skip: process.platform === "linux" ? false : "needs a Linux host" };
const ip = "192.0.2.10";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "frps-tls-rotate-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const etc = join(home, "etc");
  const frp = join(etc, "amnezia-bridge", "frp");
  const trust = join(etc, "amnezia-bridge", "frp-trust");
  const state = join(frp, ".tls-rotation");
  const pending = join(frp, ".tls-pending");
  const bin = join(home, "bin");
  for (const path of [bin, frp, trust, pending]) await mkdir(path, { mode: 0o700, recursive: true });
  const openssl = (...args) => execFileSync("openssl", args, { cwd: home, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-days", "90", "-subj", "/CN=Lab CA", "-keyout", "root.key", "-out", join(trust, "ca.crt"));
  async function leaf(dir, days, san = ip, usage = "serverAuth") {
    openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-subj", "/CN=Lab Server", "-keyout", join(dir, "server.key"), "-out", "server.csr");
    await chmod(join(dir, "server.key"), 0o600);
    await writeFile(join(home, "ext"), "extendedKeyUsage=" + usage + "\nsubjectAltName=IP:" + san + "\n");
    openssl("x509", "-req", "-in", "server.csr", "-CA", join(trust, "ca.crt"), "-CAkey", "root.key",
      "-CAcreateserial", "-days", String(days), "-extfile", "ext", "-out", join(dir, "server.crt"));
  }
  await leaf(frp, 2);
  await leaf(pending, 30);
  await writeFile(join(trust, "public-ip"), ip + "\n");
  await writeFile(join(frp, "frps.toml"), 'bindAddr = "0.0.0.0"\nbindPort = 7000\ntransport.tls.force = true\n'
    + 'transport.tls.certFile = "' + join(frp, "server.crt") + '"\ntransport.tls.keyFile = "' + join(frp, "server.key") + '"\n');
  await cp(join(frp, "server.crt"), join(home, "live.crt"));
  async function command(name, body) {
    const path = join(bin, name);
    await writeFile(path, "#!/bin/sh\nset -eu\n" + body, { mode: 0o700 });
    return path;
  }
  await command("systemctl", String.raw`
test ! -e /proc/$$/fd/9
case "$1" in
  is-active)
    case "$*" in
      *amnezia-frps-tls-boot-restore.service) test ! -f "$TEST_HOME/no-boot-guard" ;;
      *) test ! -f "$TEST_HOME/stopped" ;;
    esac
    ;;
  stop) touch "$TEST_HOME/stopped" ;;
  start)
    test -f "$TEST_HOME/stopped"
    echo restart >> "$TEST_HOME/events"
    cp "$TEST_FRP/server.crt" "$TEST_HOME/live.crt"
    rm "$TEST_HOME/stopped"
    ;;
  *) exit 1 ;;
esac
`);
  const realOpenSsl = execFileSync("sh", ["-c", "command -v openssl"], { encoding: "utf8" }).trim();
  const realDate = execFileSync("sh", ["-c", "command -v date"], { encoding: "utf8" }).trim();
  await command("date", String.raw`
if [ "$*" = "-u +%H:%M" ]; then
  if [ -f "$TEST_HOME/outside-window" ]; then printf '07:00\n'; else printf '03:00\n'; fi
else
  exec "$TEST_DATE" "$@"
fi
`);
  await command("openssl", String.raw`
if [ "$1" = s_client ]; then
  case "$*" in
    *'-connect 127.0.0.1:7000 -verifyCAfile '*'-verify_ip 192.0.2.10 -verify_return_error '*) ;;
    *) exit 2 ;;
  esac
  cat "$TEST_HOME/live.crt"
else
  exec "$TEST_OPENSSL" "$@"
fi
`);
  const gate = await command("gate", String.raw`
test ! -e /proc/$$/fd/9
case "$1" in
  baseline)
    echo baseline >> "$TEST_HOME/events"
    test ! -f "$TEST_HOME/fail-baseline"
    echo '{"opaque":true}'
    ;;
  verify)
    case "$2" in ????-??-??T??:??:??Z) ;; *) exit 2;; esac
    verify_token=$(cat)
    test "$verify_token" = '{"opaque":true}'
    echo verify >> "$TEST_HOME/events"
    if [ -f "$TEST_HOME/interrupt" ] && [ "$(grep -c verify "$TEST_HOME/events")" -eq 1 ]; then
      # Stop the transaction while the candidate is active, as on power loss.
      kill -KILL "$(cat "$TEST_HOME/transaction-pid")"
      exit 1
    fi
    if [ -f "$TEST_HOME/fail-verify" ] && [ "$(grep -c verify "$TEST_HOME/events")" -eq 1 ]; then
      exit 1
    fi
    test ! -f "$TEST_HOME/fail-all-verification"
    ;;
  *) exit 2 ;;
esac
`);
  const issuer = await command("issue", String.raw`
test ! -e /proc/$$/fd/9
echo issue >> "$TEST_HOME/events"
test ! -e "$3" && test ! -e "$4"
cp "$TEST_FRP/.tls-pending/server.crt" "$3"
cp "$TEST_FRP/.tls-pending/server.key" "$4"
`);
  const env = {
    ...process.env, PATH: bin + ":" + process.env.PATH,
    TEST_HOME: home, TEST_FRP: frp, TEST_OPENSSL: realOpenSsl, TEST_DATE: realDate,
    AMNEZIA_ETC: etc, AMNEZIA_ALLOW_NONROOT: "1",
    BRIDGE_TLS_GATE: gate, BRIDGE_TLS_ISSUER: issuer,
    BRIDGE_TLS_WINDOW_UTC: "02:00-04:00",
  };
  const run = (...args) => spawnSync("bash", ["-c", 'echo $$ > "$TEST_HOME/transaction-pid"; exec bash "$@"', "run", script, ...args],
    { env, encoding: "utf8", timeout: 12000 });
  const events = () => readFile(join(home, "events"), "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const active = () => readFile(join(frp, "server.crt"), "utf8");
  return { home, frp, trust, state, pending, run, events, active, leaf, env };
}

test("switches to a pre-issued pair as one generation and gates successful activation", linux, async t => {
  const h = await fixture(t);
  const candidate = await readFile(join(h.pending, "server.crt"), "utf8");
  const r = h.run("--apply-pending");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(await h.active(), candidate);
  assert.equal(await readlink(join(h.frp, "server.crt")), ".tls-rotation/current/server.crt");
  assert.equal(await readlink(join(h.frp, "server.key")), ".tls-rotation/current/server.key");
  assert.equal(await h.events(), "baseline\nrestart\nverify\n");
  assert.match(await readFile(join(h.trust, "deployed-sha256"), "utf8"), /^[a-f0-9]{64}\n$/);
  assert.equal((await stat(join(h.frp, "server.key"))).mode & 0o777, 0o600);
});

test("rejects a wrong SAN or failed baseline before touching the current pair", linux, async t => {
  const h = await fixture(t);
  const old = await h.active();
  await h.leaf(h.pending, 30, "192.0.2.99");
  assert.notEqual(h.run("--apply-pending").status, 0);
  assert.equal(await h.events(), "");
  await h.leaf(h.pending, 30);
  await writeFile(join(h.home, "fail-baseline"), "");
  assert.notEqual(h.run("--apply-pending").status, 0);
  assert.equal(await h.events(), "baseline\n");
  assert.equal(await h.active(), old);
});

test("restores both files and rechecks the old routes after a gate failure", linux, async t => {
  const h = await fixture(t);
  const old = await h.active();
  await writeFile(join(h.home, "fail-verify"), "");
  const r = h.run("--apply-pending");
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /restored/i);
  assert.equal(await h.active(), old);
  assert.equal(await h.events(), "baseline\nrestart\nverify\nrestart\nverify\n");
  await assert.rejects(stat(join(h.state, "transaction")), { code: "ENOENT" });
});

test("recovers a published transaction after interruption with the candidate live", linux, async t => {
  const h = await fixture(t);
  const old = await h.active();
  await writeFile(join(h.home, "interrupt"), "");
  assert.equal(h.run("--apply-pending").signal, "SIGKILL");
  assert.notEqual(await h.active(), old);
  assert.ok((await stat(join(h.state, "transaction"))).isDirectory());
  const recovery = h.run("--recover");
  assert.equal(recovery.status, 0, recovery.stderr + recovery.stdout);
  assert.equal(await h.active(), old);
  assert.equal(await h.events(), "baseline\nrestart\nverify\nrestart\nverify\n");
});

test("boot repair restores the previous pair before frps starts and leaves the route check pending", linux, async t => {
  const h = await fixture(t);
  const old = await h.active();
  await writeFile(join(h.home, "interrupt"), "");
  assert.equal(h.run("--apply-pending").signal, "SIGKILL");
  assert.notEqual(await h.active(), old);
  await writeFile(join(h.home, "stopped"), "");
  const r = h.run("--restore-pair");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(await h.active(), old);
  assert.ok((await stat(join(h.state, "transaction"))).isDirectory());
  assert.equal(await h.events(), "baseline\nrestart\nverify\n");
  // The listener opens both restored files after boot repair has completed.
  const boot = spawnSync("systemctl", ["start", "amnezia-frps.service"], { env: h.env, encoding: "utf8" });
  assert.equal(boot.status, 0, boot.stderr);
  const verified = h.run("--recover");
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  await assert.rejects(stat(join(h.state, "transaction")), { code: "ENOENT" });
  assert.equal(await h.events(), "baseline\nrestart\nverify\nrestart\nverify\n");
});

test("new rotations require the independent boot guard to be active", linux, async t => {
  const h = await fixture(t);
  await writeFile(join(h.home, "no-boot-guard"), "");
  const r = h.run("--apply-pending");
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /boot restore guard/);
  assert.equal(await h.events(), "");
});

test("automatic issuance stages a new pair and skips repeats within the same window", linux, async t => {
  const h = await fixture(t);
  const r = h.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(await h.events(), "issue\nbaseline\nrestart\nverify\n");
  assert.equal(h.run().status, 0);
  assert.equal(await h.events(), "issue\nbaseline\nrestart\nverify\n");
});

test("a scheduled rotation outside the configured UTC window does not issue or restart", linux, async t => {
  const h = await fixture(t);
  await writeFile(join(h.home, "outside-window"), "");
  const r = h.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(await h.events(), "");
});

test("a candidate must have a matching key and extend service beyond the renewal threshold", linux, async t => {
  const h = await fixture(t);
  await cp(join(h.frp, "server.key"), join(h.pending, "server.key"));
  const mismatch = h.run("--apply-pending");
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /key mismatch/);
  await h.leaf(h.pending, 3);
  const short = h.run("--apply-pending");
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /beyond the renewal threshold/);
  assert.equal(await h.events(), "");
});

test("a pending Step bootstrap pair also needs TLS client authentication", linux, async t => {
  const h = await fixture(t);
  delete h.env.BRIDGE_TLS_ISSUER;
  h.env.FRPS_TLS_CA_URL = "https://issuer.example.invalid";
  const rejected = h.run("--apply-pending");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /TLS client/);
  assert.equal(await h.events(), "");
  await h.leaf(h.pending, 30, ip, "serverAuth,clientAuth");
  const accepted = h.run("--apply-pending");
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.equal(await h.events(), "baseline\nrestart\nverify\n");
});

test("a failed rollback gate retains its journal and can retry without stopping the restored frps", linux, async t => {
  const h = await fixture(t);
  const old = await h.active();
  await writeFile(join(h.home, "fail-all-verification"), "");
  const r = h.run("--apply-pending");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /rollback could not be verified/);
  assert.equal(await h.active(), old);
  assert.ok((await stat(join(h.state, "transaction"))).isDirectory());
  await rm(join(h.home, "fail-all-verification"));
  const recovery = h.run("--recover");
  assert.equal(recovery.status, 0, recovery.stderr + recovery.stdout);
  assert.equal(await h.events(), "baseline\nrestart\nverify\nrestart\nverify\nverify\n");
});

test("after a verified rollback the timer will not restart routes repeatedly within one day", linux, async t => {
  const h = await fixture(t);
  await writeFile(join(h.home, "fail-verify"), "");
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /routes restored/);
  assert.equal(h.run().status, 0);
  assert.equal(await h.events(), "issue\nbaseline\nrestart\nverify\nrestart\nverify\n");
});

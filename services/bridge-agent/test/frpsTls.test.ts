import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { X509Certificate } from "node:crypto";
import { createServer } from "node:tls";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createFrpsTlsSampler, createFrpsTlsSamplerForOwner } from "../src/frpsTls.js";

const BRIDGE_IP = "203.0.113.10";
const FIXTURE_UID = process.getuid?.() ?? 0;
let root: string;
let ca: Buffer;
let otherCa: Buffer;
let key: Buffer;
let leaf: Buffer;
let expired: Buffer;
const trustDirectories = new Set<string>();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bridge-tls-"));
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: root, stdio: "ignore" });
  for (const name of ["ca", "other"]) {
    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-noenc", "-days", "90",
      "-subj", `/CN=Bridge lab ${name}`, "-keyout", `${name}.key`, "-out", `${name}.crt`);
  }
  openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-noenc", "-subj", "/CN=Bridge lab leaf",
    "-keyout", "leaf.key", "-out", "leaf.csr");
  await writeFile(join(root, "server.ext"), `subjectAltName=IP:${BRIDGE_IP}\nextendedKeyUsage=serverAuth\n`);
  openssl("x509", "-req", "-CA", "ca.crt", "-CAkey", "ca.key", "-in", "leaf.csr", "-days", "14",
    "-extfile", "server.ext", "-out", "leaf.crt");
  await writeFile(join(root, "ca-index.txt"), "");
  await writeFile(join(root, "ca-serial"), "1000\n");
  await writeFile(join(root, "ca.cnf"), [
    "[ca]", "default_ca = fixture_ca",
    "[fixture_ca]", "certificate = ca.crt", "private_key = ca.key", "database = ca-index.txt",
    "serial = ca-serial", "new_certs_dir = .", "default_md = sha256", "policy = fixture_policy",
    "[fixture_policy]", "commonName = supplied",
  ].join("\n"));
  openssl("ca", "-batch", "-notext", "-config", "ca.cnf", "-in", "leaf.csr", "-out", "expired.crt",
    "-startdate", "20000101000000Z", "-enddate", "20000102000000Z", "-extfile", "server.ext");
  [ca, otherCa, key, leaf, expired] = await Promise.all(["ca.crt", "other.crt", "leaf.key", "leaf.crt", "expired.crt"]
    .map((name) => readFile(join(root, name)))) as [Buffer, Buffer, Buffer, Buffer, Buffer];
});

afterAll(async () => {
  await Promise.all([...trustDirectories].map((dir) => chmod(dir, 0o700)));
  if (root) await rm(root, { recursive: true, force: true });
});

async function restrictTrustDirectory(dir: string) {
  trustDirectories.add(dir);
  await chmod(dir, 0o555);
}

async function writeTrustFile(path: string, content: string | Buffer) {
  const directory = dirname(path);
  await chmod(directory, 0o700);
  try {
    // Node reports DOS read-only attributes as the write mode on Windows.
    await chmod(path, 0o644).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await writeFile(path, content);
    await chmod(path, 0o444);
  } finally {
    await restrictTrustDirectory(directory);
  }
}

async function withPeer(cert: Buffer, fn: (port: number) => Promise<void>) {
  const server = createServer({ key, cert }, (socket) => socket.end());
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await fn((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it("checks the live peer with pinned IPv4 and CA, reports expiry and compares the published fingerprint", async () => {
  const trust = await mkdtemp(join(root, "trust-"));
  await restrictTrustDirectory(trust);
  const fingerprint = new X509Certificate(leaf).fingerprint256.replaceAll(":", "").toLowerCase();
  await writeTrustFile(join(trust, "public-ip"), BRIDGE_IP);
  await writeTrustFile(join(trust, "ca.crt"), ca);

  await withPeer(leaf, async (port) => {
    const sample = createFrpsTlsSamplerForOwner(trust, port, FIXTURE_UID);
    const verified = {
      state: "verified",
      expiresAt: new X509Certificate(leaf).validToDate.toISOString(),
      expiresSoon: true,
      fingerprintSha256: fingerprint,
    };
    expect(await sample()).toEqual({ ...verified, matchesDeployed: null });
    await writeTrustFile(join(trust, "deployed-sha256"), `${"a".repeat(64)}\n`);
    expect(await sample()).toEqual({ ...verified, matchesDeployed: false });
    await writeTrustFile(join(trust, "deployed-sha256"), fingerprint);
    expect(await sample()).toEqual({ ...verified, matchesDeployed: true });

    await writeTrustFile(join(trust, "public-ip"), "203.0.113.11");
    expect(await sample()).toEqual({ state: "failed", reason: "wrong_ip" });
    await writeTrustFile(join(trust, "public-ip"), BRIDGE_IP);
    await writeTrustFile(join(trust, "ca.crt"), otherCa);
    expect(await sample()).toEqual({ state: "failed", reason: "untrusted" });
  });

  await writeTrustFile(join(trust, "ca.crt"), ca);
  await withPeer(expired, async (port) => {
    expect(await createFrpsTlsSamplerForOwner(trust, port, FIXTURE_UID)()).toEqual({
      state: "failed", reason: "expired",
    });
  });
});

it("reports legacy hosts separately from unsafe or incomplete configuration", async () => {
  const trust = join(root, "absent");
  const sample = createFrpsTlsSamplerForOwner(trust, 7000, FIXTURE_UID);
  expect(await sample()).toEqual({ state: "unconfigured" });
  await mkdir(trust, { mode: 0o755 });
  await restrictTrustDirectory(trust);
  expect(await sample()).toEqual({ state: "unconfigured" });
  await writeTrustFile(join(trust, "public-ip"), BRIDGE_IP);
  expect(await sample()).toEqual({ state: "failed", reason: "config" });
  await writeTrustFile(join(trust, "ca.crt"), ca);
  await chmod(join(trust, "ca.crt"), 0o666);
  expect(await sample()).toEqual({ state: "failed", reason: "config" });
});

it("rejects a trust directory with the wrong owner and keeps the production owner at UID 0", async () => {
  const trust = await mkdtemp(join(root, "owner-"));
  await restrictTrustDirectory(trust);
  const otherUid = FIXTURE_UID === 0 ? 1 : 0;
  expect(await createFrpsTlsSamplerForOwner(trust, 7000, otherUid)()).toEqual({
    state: "failed", reason: "config",
  });
  expect(await createFrpsTlsSampler(trust, 7000)()).toEqual(
    FIXTURE_UID === 0 ? { state: "unconfigured" } : { state: "failed", reason: "config" },
  );
});

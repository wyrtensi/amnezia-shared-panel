import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { execFileExec } from "../src/exec.js";
import { httpGet, pingLevel, tcpBannerLevel } from "../src/levels.js";
import { Tunnel } from "../src/tunnel.js";
import type { ParsedClientConfig } from "../src/config.js";
import { fakeClock, isHandshakePoll, recordingExec } from "./fakes.js";

const CFG: ParsedClientConfig = {
  address: "10.90.0.7",
  mtu: 1280,
  endpointHost: "192.0.2.10",
  endpointPort: 51890,
  stripped: "[Interface]\n",
};

const servers: (NetServer | HttpServer)[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const listen = async <T extends NetServer | HttpServer>(server: T): Promise<number> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

describe("execFileExec", () => {
  it("reports the exit code, stdout and stdin input without a shell", async () => {
    const ok = await execFileExec(process.execPath, [
      "-e",
      "process.stdin.pipe(process.stdout)",
    ], { input: "hello; echo not-a-shell" });
    expect(ok).toMatchObject({ code: 0, stdout: "hello; echo not-a-shell" });
    const failed = await execFileExec(process.execPath, ["-e", "process.exit(3)"]);
    expect(failed.code).toBe(3);
  });

  it("kills a command that runs past its timeout", async () => {
    const started = Date.now();
    const result = await execFileExec(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      timeoutMs: 200,
    });
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports a missing binary as a failure instead of throwing", async () => {
    const result = await execFileExec("/nonexistent/binary", []);
    expect(result.code).not.toBe(0);
  });
});

describe("pingLevel", () => {
  it("runs ping -c 3 -W 2 -q and passes on exit 0 with the average rtt", async () => {
    const fake = recordingExec(() => ({
      stdout:
        "--- 192.0.2.10 ping statistics ---\n3 packets transmitted, 3 packets received, 0% packet loss\nround-trip min/avg/max = 10.100/12.345/14.000 ms\n",
    }));
    const result = await pingLevel(fake.exec, "192.0.2.10");
    expect(fake.lines()).toEqual(["ping -c 3 -W 2 -q 192.0.2.10"]);
    expect(result).toEqual({ ok: true, detail: "3/3 received", latencyMs: 12 });
  });

  it("fails on a non-zero exit", async () => {
    const fake = recordingExec(() => ({
      code: 1,
      stdout: "3 packets transmitted, 0 packets received, 100% packet loss\n",
    }));
    expect(await pingLevel(fake.exec, "192.0.2.10")).toEqual({
      ok: false,
      detail: "0/3 received",
      latencyMs: null,
    });
  });
});

describe("tcpBannerLevel", () => {
  it("passes when the first line is an SSH banner", async () => {
    const port = await listen(
      createNetServer((socket) => socket.end("SSH-2.0-OpenSSH_9.6 Testland\r\nrest")),
    );
    const result = await tcpBannerLevel("127.0.0.1", port);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("SSH-2.0-OpenSSH_9.6 Testland");
    expect(result.latencyMs).toEqual(expect.any(Number));
  });

  it("fails on a banner that is not SSH and caps it at 80 chars", async () => {
    const port = await listen(createNetServer((socket) => socket.end(`HTTP/1.1 400 ${"x".repeat(200)}\n`)));
    const result = await tcpBannerLevel("127.0.0.1", port);
    expect(result.ok).toBe(false);
    expect(result.detail).toHaveLength(80);
    expect(result.detail?.startsWith("HTTP/1.1 400")).toBe(true);
  });

  it("reports the error code when the port refuses", async () => {
    const server = createNetServer();
    const port = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
    expect(await tcpBannerLevel("127.0.0.1", port)).toEqual({
      ok: false,
      detail: "ECONNREFUSED",
      latencyMs: null,
    });
  });

  it("times out on a silent server", async () => {
    const port = await listen(createNetServer(() => {}));
    expect(await tcpBannerLevel("127.0.0.1", port, 150)).toEqual({
      ok: false,
      detail: "timeout",
      latencyMs: null,
    });
  });
});

describe("httpGet", () => {
  it("returns status and body, bound to localAddress", async () => {
    const port = await listen(
      createHttpServer((req, res) => res.end(req.socket.remoteAddress?.replace("::ffff:", ""))),
    );
    expect(
      await httpGet(`http://127.0.0.1:${port}/`, { localAddress: "127.0.0.1", timeoutMs: 2000 }),
    ).toEqual({ status: 200, body: "127.0.0.1" });
  });

  it("caps the body at 4 KiB", async () => {
    const port = await listen(createHttpServer((_req, res) => res.end("a".repeat(100_000))));
    const result = await httpGet(`http://127.0.0.1:${port}/`, { timeoutMs: 2000 });
    expect(result.body).toHaveLength(4096);
  });

  it("rejects when the server does not answer in time", async () => {
    const port = await listen(createHttpServer(() => {}));
    await expect(httpGet(`http://127.0.0.1:${port}/`, { timeoutMs: 150 })).rejects.toThrow(/timeout/);
  });

  it("does not follow redirects", async () => {
    const port = await listen(
      createHttpServer((_req, res) => {
        res.writeHead(302, { location: "http://198.51.100.1/" });
        res.end();
      }),
    );
    expect((await httpGet(`http://127.0.0.1:${port}/`, { timeoutMs: 2000 })).status).toBe(302);
  });

  it("refuses a non-http url", async () => {
    await expect(httpGet("file:///etc/passwd", { timeoutMs: 100 })).rejects.toThrow();
  });
});

describe("Tunnel", () => {
  it("tunnel.up issues the commands in order", async () => {
    const fake = recordingExec();
    await new Tunnel(fake.exec).up(CFG, "/tmp/probe-x.conf");
    expect(fake.lines()).toEqual([
      "amneziawg-go awgp0",
      "awg setconf awgp0 /tmp/probe-x.conf",
      "ip address add 10.90.0.7/32 dev awgp0",
      "ip link set mtu 1280 up dev awgp0",
      "ip rule add from 10.90.0.7 lookup 200",
      "ip route add default dev awgp0 table 200",
    ]);
    for (const line of fake.lines()) {
      expect(line).not.toMatch(/\bmain\b/);
      if (line.startsWith("ip route")) expect(line).toMatch(/table 200$/);
    }
  });

  it("leaves the MTU alone when the config has none", async () => {
    const fake = recordingExec();
    await new Tunnel(fake.exec).up({ ...CFG, mtu: null }, "/tmp/c.conf");
    expect(fake.lines()).toContain("ip link set up dev awgp0");
  });

  it("tunnel.up stops at the first failing command with a fixed reason", async () => {
    const fake = recordingExec((call) =>
      call.cmd === "awg" ? { code: 1, stderr: "Line unrecognized: `PrivateKey=SENTINEL'" } : {},
    );
    const tunnel = new Tunnel(fake.exec);
    const error = (await tunnel.up(CFG, "/tmp/c.conf").then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("awg setconf failed (exit 1)");
    expect(error.message).not.toContain("SENTINEL");
    expect(fake.lines()).toHaveLength(2);
  });

  it("tunnel.down runs even after a failed up and swallows errors", async () => {
    const fake = recordingExec((call) => {
      if (call.cmd === "ip" && call.args[0] === "rule" && call.args[1] === "add") {
        return { code: 2, stderr: "RTNETLINK answers: Operation not permitted" };
      }
      if (call.args.includes("del") || call.args.includes("delete") || call.args.includes("flush")) {
        throw new Error("exec blew up");
      }
      return {};
    });
    const tunnel = new Tunnel(fake.exec);
    await expect(tunnel.up(CFG, "/tmp/c.conf")).rejects.toThrow(
      "ip rule failed (exit 2): RTNETLINK answers: Operation not permitted",
    );
    const before = fake.calls.length;
    await expect(tunnel.down()).resolves.toBeUndefined();
    expect(fake.lines().slice(before)).toEqual([
      "ip rule del from 10.90.0.7 lookup 200",
      "ip route flush table 200",
      "ip link delete awgp0",
    ]);
    // Idempotent: a second down neither throws nor repeats the rule delete.
    await expect(tunnel.down()).resolves.toBeUndefined();
  });

  it("waitHandshake ok when latest-handshakes epoch > 0", async () => {
    let polls = 0;
    const fake = recordingExec((call) => {
      if (!isHandshakePoll(call)) return {};
      polls += 1;
      return { stdout: `cHVibGlj\t${polls >= 3 ? 1_700_000_123 : 0}\n` };
    });
    const clock = fakeClock();
    const tunnel = new Tunnel(fake.exec, "awgp0", 200, clock);
    await tunnel.up(CFG, "/tmp/c.conf");
    expect(await tunnel.waitHandshake()).toEqual({ ok: true, detail: null, latencyMs: 1000 });
  });

  it("waitHandshake fails with detail \"no handshake in 15s\" when always 0", async () => {
    const fake = recordingExec((call) => (isHandshakePoll(call) ? { stdout: "cHVibGlj\t0\n" } : {}));
    const clock = fakeClock();
    const tunnel = new Tunnel(fake.exec, "awgp0", 200, clock);
    await tunnel.up(CFG, "/tmp/c.conf");
    expect(await tunnel.waitHandshake()).toEqual({
      ok: false,
      detail: "no handshake in 15s",
      latencyMs: null,
    });
    const polls = fake.calls.filter(isHandshakePoll).length;
    expect(polls).toBeGreaterThanOrEqual(30);
    expect(polls).toBeLessThanOrEqual(32);
  });
});

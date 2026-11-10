import type { ParsedClientConfig } from "./config.js";
import type { Exec } from "./exec.js";
import type { LevelResult } from "./types.js";

export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class TunnelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelError";
  }
}

/**
 * One userspace AWG client interface in the probe's own network namespace.
 *
 * Only sockets bound to the tunnel address use it: a source rule sends them to
 * a private table whose default route is the tunnel. The main table is never
 * touched, so the API, the control request and the AWG UDP itself stay on eth0.
 */
export class Tunnel {
  private address: string | null = null;

  constructor(
    private readonly exec: Exec,
    readonly iface = "awgp0",
    readonly table = 200,
    private readonly clock: Clock = realClock,
  ) {}

  private async run(cmd: string, args: string[], timeoutMs = 10_000): Promise<void> {
    const result = await this.exec(cmd, args, { timeoutMs });
    if (result.code === 0) return;
    const what = cmd === "amneziawg-go" ? cmd : `${cmd} ${args[0]}`;
    // awg may echo a config line (a key) in its errors; only ip's are quoted.
    const reason =
      cmd === "ip"
        ? (result.stderr.split("\n")[0] ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, 120)
        : "";
    throw new TunnelError(`${what} failed (exit ${result.code})${reason ? `: ${reason}` : ""}`);
  }

  async up(cfg: ParsedClientConfig, confPath: string): Promise<void> {
    const table = String(this.table);
    // Recorded first, so down() after a half-done up() still removes the rule.
    this.address = cfg.address;
    await this.run("amneziawg-go", [this.iface]);
    await this.run("awg", ["setconf", this.iface, confPath]);
    await this.run("ip", ["address", "add", `${cfg.address}/32`, "dev", this.iface]);
    await this.run("ip", [
      "link",
      "set",
      ...(cfg.mtu === null ? [] : ["mtu", String(cfg.mtu)]),
      "up",
      "dev",
      this.iface,
    ]);
    await this.run("ip", ["rule", "add", "from", cfg.address, "lookup", table]);
    await this.run("ip", ["route", "add", "default", "dev", this.iface, "table", table]);
  }

  /** Poll for a completed handshake; the client's keepalive starts one at once. */
  async waitHandshake(timeoutMs = 15_000, pollMs = 500): Promise<LevelResult> {
    const started = this.clock.now();
    for (;;) {
      const result = await this.exec("awg", ["show", this.iface, "latest-handshakes"], {
        timeoutMs: 5000,
      });
      if (result.code === 0) {
        const done = result.stdout
          .split("\n")
          .some((line) => Number(line.trim().split(/\s+/)[1] ?? 0) > 0);
        if (done) return { ok: true, detail: null, latencyMs: this.clock.now() - started };
      }
      if (this.clock.now() - started >= timeoutMs) {
        return { ok: false, detail: `no handshake in ${Math.round(timeoutMs / 1000)}s`, latencyMs: null };
      }
      await this.clock.sleep(pollMs);
    }
  }

  /** Remove the rule, the table and the link. Idempotent, never throws. */
  async down(): Promise<void> {
    const table = String(this.table);
    const steps: [string, string[]][] = [];
    if (this.address) steps.push(["ip", ["rule", "del", "from", this.address, "lookup", table]]);
    steps.push(["ip", ["route", "flush", "table", table]]);
    steps.push(["ip", ["link", "delete", this.iface]]);
    this.address = null;
    for (const [cmd, args] of steps) {
      try {
        await this.exec(cmd, args, { timeoutMs: 5000 });
      } catch {
        // Teardown is best effort; a missing link or rule is the normal case.
      }
    }
  }
}

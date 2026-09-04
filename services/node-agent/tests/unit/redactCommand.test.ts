import { describe, expect, it } from "vitest";
import { REDACTED, redactCommand } from "@/utils/redactCommand";
import {
  buildValidatedWgConfigCommand,
  buildWriteFileCommand,
} from "@/utils/shellWrite";

// A realistic awg0.conf. The values are syntactically valid but invented —
// never paste a real key into a test (AGENTS.md).
const PRIVATE_KEY = "qJ5s0vQ8kK3mX7nZ1pB2rT4wY6uI8oA0sD2fG4hJ6lM=";
const PRESHARED_KEY = "zY9xW8vU7tS6rQ5pO4nM3lK2jI1hG0fE9dC8bA7zY6x=";
const WG_CONFIG = [
  "[Interface]",
  "Address = 10.8.1.1/24",
  "ListenPort = 51820",
  `PrivateKey = ${PRIVATE_KEY}`,
  "",
  "[Peer]",
  "PublicKey = aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4c=",
  `PresharedKey = ${PRESHARED_KEY}`,
  "AllowedIPs = 10.8.1.2/32",
].join("\n");

// Mirror helpers/*Connection.ts buildCommand(): the error message carries this
// re-quoted form, not the raw command.
const dockerWrap = (cmd: string) =>
  `docker exec amnezia-awg sh -lc '${cmd.replace(/'/g, "'\\''")}'`;

describe("redactCommand", () => {
  // The write commands are the reason this helper exists, so keep asserting
  // that they carry nothing to redact in the first place. Content travels on
  // stdin now; if it ever moves back into the command, this fails here rather
  // than quietly in a log on a node.
  it("has nothing to redact in a write command, because the payload is on stdin", () => {
    const encoded = Buffer.from(WG_CONFIG, "utf-8").toString("base64");
    const commands = [
      buildValidatedWgConfigCommand("/opt/amnezia/awg/wg0.conf", "awg-quick"),
      buildWriteFileCommand("/opt/amnezia/awg/clientsTable"),
    ];

    for (const cmd of commands) {
      expect(cmd).not.toContain(encoded);
      expect(cmd).not.toContain(PRIVATE_KEY);
      expect(redactCommand(cmd)).toBe(cmd);
    }
  });

  it("removes an encoded payload from a stringified error", () => {
    const encoded = Buffer.from(WG_CONFIG, "utf-8").toString("base64");
    const execError = `Error: Command failed: ${dockerWrap(
      `echo '${encoded}' | base64 -d`,
    )}\nwg-quick: parse error`;

    const redacted = redactCommand(execError);

    expect(redacted).not.toContain(encoded);
    expect(redacted).toContain(REDACTED);
    // The diagnostically useful shape survives.
    expect(redacted).toContain("wg-quick: parse error");
    expect(redacted).toContain("docker exec amnezia-awg");
  });

  // What `awg-quick strip` actually prints when the config it was handed does
  // not parse: the offending line, verbatim, PrivateKey and all.
  it("removes a key from the stderr the tool itself prints back", () => {
    const stderr = [
      "#[1] Line unrecognized: `PrivateKey = " + PRIVATE_KEY + "`",
      "#[2] Line unrecognized: `PresharedKey = " + PRESHARED_KEY + "`",
    ].join("\n");

    const redacted = redactCommand(stderr);

    expect(redacted).not.toContain(PRIVATE_KEY);
    expect(redacted).not.toContain(PRESHARED_KEY);
    expect(redacted).toContain("Line unrecognized");
  });

  it("removes a key written out literally, e.g. echoed back in stderr", () => {
    const stderr = `Line unrecognized: 'PrivateKey = ${PRIVATE_KEY}'`;

    const redacted = redactCommand(stderr);

    expect(redacted).not.toContain(PRIVATE_KEY);
    expect(redacted).toBe(`Line unrecognized: 'PrivateKey = ${REDACTED}'`);
  });

  it("redacts PresharedKey and SecretKey the same way", () => {
    expect(redactCommand(`PresharedKey = ${PRESHARED_KEY}`)).not.toContain(
      PRESHARED_KEY,
    );
    expect(redactCommand(`SecretKey=${PRESHARED_KEY}`)).toBe(
      `SecretKey=${REDACTED}`,
    );
  });

  it("leaves ordinary commands and paths untouched", () => {
    for (const cmd of [
      "wg show wg0 dump",
      "cat /opt/amnezia/awg/wireguard_server_public_key.key 2>/dev/null || true",
      "docker exec amnezia-awg3 sh -lc 'awg genkey'",
      "systemctl restart amnezia-node-agent",
    ]) {
      expect(redactCommand(cmd)).toBe(cmd);
    }
  });

  it("keeps a public key, which is not secret and is useful in a log", () => {
    const line = "PublicKey = aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4c=";
    expect(redactCommand(line)).toBe(line);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppContract } from "@/contracts/app";
import appConfig from "@/constants/appConfig";
import {
  DEFAULT_IPV6_REJECT_STUB_PREFIX,
  deriveStubPeerIpv6,
  deriveStubServerIpv6,
  formatIpv6RejectStubEnv,
  normalizeUla64Prefix,
  parseIpv6RejectStubEnv,
  rewriteAwg3PeersForIpv6RejectStub,
} from "@/helpers/ipv6RejectStub";
import { AmneziaWg3Service } from "@/services/amneziaWg3";
import { PeerStatus } from "@/types/clients";
import { ClientErrorCode } from "@/types/shared";
import { APIError } from "@/utils/APIError";
import { createAmneziaConnectionMock } from "../mocks";

const AWG3_CONFIG_WITH_PEERS = `[Interface]
PrivateKey = server-priv
Address = 10.90.0.1/22
ListenPort = 51890
Jc = 8
Jmin = 62
Jmax = 260
S1 = 15
S2 = 18
S3 = 20
S4 = 23
H1 = 1000
H2 = 2000
H3 = 3000
H4 = 4000
HeaderProtectionKey = server-hp-key

[Peer]
PublicKey = active-peer-1
PresharedKey = preshared-key
AllowedIPs = 10.90.0.2/32

[Peer]
PublicKey = disabled-peer-2
PresharedKey = preshared-key
AllowedIPs = 0.0.0.0/32
`;

const originalAppConfig = {
  SERVER_MAX_PEERS: appConfig.SERVER_MAX_PEERS,
  SERVER_NAME: appConfig.SERVER_NAME,
  SERVER_PUBLIC_HOST: appConfig.SERVER_PUBLIC_HOST,
};

beforeEach(() => {
  appConfig.SERVER_MAX_PEERS = 500;
  appConfig.SERVER_NAME = "{username} via {protocol}";
  appConfig.SERVER_PUBLIC_HOST = "vpn.example.test";
});

afterEach(() => {
  Object.assign(appConfig, originalAppConfig);
});

describe("ipv6RejectStub helpers", () => {
  it("validates ULA /64 prefixes and derives server and peer addresses", () => {
    expect(normalizeUla64Prefix("FD6B:7C2E:4A91:009F::/64")).toBe(
      DEFAULT_IPV6_REJECT_STUB_PREFIX,
    );
    expect(normalizeUla64Prefix("2001:db8::/64")).toBeNull();
    expect(normalizeUla64Prefix("fd6b:7c2e:4a91:9f::1/64")).toBeNull();
    expect(deriveStubServerIpv6(DEFAULT_IPV6_REJECT_STUB_PREFIX)).toBe(
      "fd6b:7c2e:4a91:9f::1",
    );
    expect(
      deriveStubPeerIpv6(
        "10.90.0.2",
        "10.90.0.1/22",
        DEFAULT_IPV6_REJECT_STUB_PREFIX,
      ),
    ).toBe("fd6b:7c2e:4a91:9f::2");
    expect(
      deriveStubPeerIpv6(
        "10.90.1.5",
        "10.90.0.1/22",
        DEFAULT_IPV6_REJECT_STUB_PREFIX,
      ),
    ).toBe("fd6b:7c2e:4a91:9f::105");
  });

  it("formats and parses ipv6-reject-stub.env", () => {
    const enabledEnv = formatIpv6RejectStubEnv(
      true,
      DEFAULT_IPV6_REJECT_STUB_PREFIX,
    );
    expect(enabledEnv).toContain("ENABLED=1");
    expect(enabledEnv).toContain("SERVER_IPV6=fd6b:7c2e:4a91:9f::1");
    expect(parseIpv6RejectStubEnv(enabledEnv)).toEqual({
      enabled: true,
      prefix: DEFAULT_IPV6_REJECT_STUB_PREFIX,
    });

    const disabledEnv = formatIpv6RejectStubEnv(
      false,
      DEFAULT_IPV6_REJECT_STUB_PREFIX,
    );
    expect(parseIpv6RejectStubEnv(disabledEnv)).toEqual({
      enabled: false,
      prefix: DEFAULT_IPV6_REJECT_STUB_PREFIX,
    });
  });

  it("rewrites only active peers when toggling on and off", () => {
    const enabled = rewriteAwg3PeersForIpv6RejectStub(AWG3_CONFIG_WITH_PEERS, {
      enabled: true,
      prefix: DEFAULT_IPV6_REJECT_STUB_PREFIX,
    });
    expect(enabled.changed).toBe(true);
    expect(enabled.config).toContain(
      "AllowedIPs = 10.90.0.2/32, fd6b:7c2e:4a91:9f::2/128",
    );
    expect(enabled.config).toContain("AllowedIPs = 0.0.0.0/32");

    const disabled = rewriteAwg3PeersForIpv6RejectStub(enabled.config, {
      enabled: false,
      prefix: DEFAULT_IPV6_REJECT_STUB_PREFIX,
    });
    expect(disabled.changed).toBe(true);
    expect(disabled.config).toBe(AWG3_CONFIG_WITH_PEERS);
  });
});

describe("AmneziaWg3Service IPv6 active-reject stub", () => {
  const createSupportedMock = () => {
    let liveAddr = "";
    let liveProhibit = false;

    const mock = createAmneziaConnectionMock({
      wgConfig: AWG3_CONFIG_WITH_PEERS,
      wgDump: "",
      clientsTable: [
        {
          clientId: "active-peer-1",
          userData: { clientName: "alice", allowedIp: "10.90.0.2" },
        },
        {
          clientId: "disabled-peer-2",
          userData: { clientName: "bob", allowedIp: "10.90.0.3" },
        },
      ],
      files: {
        "/proc/sys/net/ipv6/conf/all/forwarding": "1\n",
        "/proc/sys/net/ipv6/conf/awg0/disable_ipv6": "0\n",
      },
    });

    const baseRun = mock.spies.run.getMockImplementation()!;
    mock.spies.run.mockImplementation(async (command, options) => {
      const addrReplace = command.match(
        /^ip -6 address replace (\S+) dev awg0 nodad$/,
      );
      if (addrReplace) {
        liveAddr = addrReplace[1];
        return { stdout: "", stderr: "" };
      }
      if (command.startsWith("ip -6 address del ")) {
        if (liveAddr && command.includes(liveAddr)) liveAddr = "";
        return { stdout: "", stderr: "" };
      }
      if (command === "ip -6 route replace prohibit 2000::/3") {
        liveProhibit = true;
        return { stdout: "", stderr: "" };
      }
      if (command.startsWith("ip -6 route del prohibit 2000::/3")) {
        liveProhibit = false;
        return { stdout: "", stderr: "" };
      }
      if (command.startsWith("ip -6 -o addr show dev awg0")) {
        return {
          stdout: liveAddr ? `4: awg0 inet6 ${liveAddr} scope global\n` : "",
          stderr: "",
        };
      }
      if (command.startsWith("ip -6 route get ")) {
        return {
          stdout: liveProhibit
            ? "prohibit 2001:4860:4860::8888 dev lo table main\n"
            : "RTNETLINK answers: Network is unreachable\n",
          stderr: "",
        };
      }
      return baseRun(command, options);
    });

    return mock;
  };

  it("reports unsupported when IPv6 forwarding sysctl is disabled and refuses enabling with 409", async () => {
    const mock = createAmneziaConnectionMock({
      wgConfig: AWG3_CONFIG_WITH_PEERS,
      files: {
        "/proc/sys/net/ipv6/conf/all/forwarding": "0\n",
        "/proc/sys/net/ipv6/conf/awg0/disable_ipv6": "0\n",
      },
    });
    const service = new AmneziaWg3Service(mock.connection);

    await expect(service.getIpv6RejectStubStatus()).resolves.toEqual({
      supported: false,
      enabled: false,
      active: false,
      prefix: DEFAULT_IPV6_REJECT_STUB_PREFIX,
      reason: "ipv6_forwarding_disabled",
    });

    await expect(
      service.setIpv6RejectStub({ enabled: true }),
    ).rejects.toMatchObject({
      statusCode: ClientErrorCode.CONFLICT,
    });
  });

  it("rejects non-ULA prefixes with 400", async () => {
    const mock = createSupportedMock();
    const service = new AmneziaWg3Service(mock.connection);

    try {
      await service.setIpv6RejectStub({
        enabled: true,
        prefix: "2001:db8::/64",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).statusCode).toBe(ClientErrorCode.BAD_REQUEST);
    }
  });

  it("enables stub, backfills active peers, preserves disabled IPv4 reservation on create/re-enable, and disables cleanly", async () => {
    const mock = createSupportedMock();
    const service = new AmneziaWg3Service(mock.connection);

    const enabled = await service.setIpv6RejectStub({ enabled: true });
    expect(enabled).toEqual({
      supported: true,
      enabled: true,
      active: true,
      prefix: DEFAULT_IPV6_REJECT_STUB_PREFIX,
      reason: null,
    });
    expect(mock.state.wgConfig).toContain(
      "AllowedIPs = 10.90.0.2/32, fd6b:7c2e:4a91:9f::2/128",
    );
    expect(mock.state.wgConfig).toContain("AllowedIPs = 0.0.0.0/32");
    expect(
      mock.state.files[AppContract.AmneziaWG3.PATHS.IPV6_REJECT_STUB_ENV],
    ).toContain("ENABLED=1");
    expect(mock.spies.syncWgConfig).toHaveBeenCalledTimes(1);

    // Creating a new peer must NOT reuse 10.90.0.2 (comma AllowedIPs) or 10.90.0.3 (disabled peer).
    await service.createClient("charlie");
    expect(mock.state.wgConfig).toContain(
      "AllowedIPs = 10.90.0.4/32, fd6b:7c2e:4a91:9f::4/128",
    );

    // Re-enabling disabled-peer-2 restores both its IPv4 and derived ULA /128.
    await service.updateClient("disabled-peer-2", {
      status: PeerStatus.Active,
    });
    expect(mock.state.wgConfig).toContain(
      "AllowedIPs = 10.90.0.3/32, fd6b:7c2e:4a91:9f::3/128",
    );

    // Disabling strips ULA from all peers and cleans kernel state.
    const disabled = await service.setIpv6RejectStub({ enabled: false });
    expect(disabled).toEqual({
      supported: true,
      enabled: false,
      active: false,
      prefix: DEFAULT_IPV6_REJECT_STUB_PREFIX,
      reason: null,
    });
    expect(mock.state.wgConfig).not.toContain("fd6b:7c2e:4a91:9f");
    expect(mock.state.wgConfig).toContain("AllowedIPs = 10.90.0.2/32");
    expect(mock.state.wgConfig).toContain("AllowedIPs = 10.90.0.3/32");
    expect(mock.state.wgConfig).toContain("AllowedIPs = 10.90.0.4/32");
    expect(
      mock.state.files[AppContract.AmneziaWG3.PATHS.IPV6_REJECT_STUB_ENV],
    ).toContain("ENABLED=0");
  });
});

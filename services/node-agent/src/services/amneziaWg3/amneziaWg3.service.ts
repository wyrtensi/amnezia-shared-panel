import { ClientErrorCode, Protocol } from "@/types/shared";
import { AwgVersion } from "@/types/amnezia";
import { AppContract } from "@/contracts/app";
import { IAmneziaConnection } from "@/types/amnezia";
import { Ipv6RejectStubStatus } from "@/types/server";
import { APIError } from "@/utils/APIError";
import {
  parseAwgParams,
  resolveAwgVersion,
  dropEmptyConfigLines,
  AWG_SPECIAL_JUNK_KEYS,
} from "@/helpers/awgConfig";
import {
  DEFAULT_IPV6_REJECT_STUB_PREFIX,
  IPV6_REJECT_PROBE_TARGET,
  deriveStubPeerIpv6,
  deriveStubServerIpv6,
  extractServerIpv4Cidr,
  formatIpv6RejectStubEnv,
  normalizeUla64Prefix,
  parseIpv6RejectStubEnv,
  rewriteAwg3PeersForIpv6RejectStub,
} from "@/helpers/ipv6RejectStub";
import {
  AmneziaWgPaths,
  ClientArtifacts,
  ClientArtifactInput,
  AmneziaWgServiceBase,
} from "@/services/amneziaWgShared";

/**
 * AmneziaWG 3.1 service.
 * If the underlying container is still on 2.0, the client config is built
 * from the 2.0 parameters that are actually present.
 */
export class AmneziaWg3Service extends AmneziaWgServiceBase {
  static key = "amneziaWg3Service";

  // AmneziaWG 3.1 client config template
  private static readonly CLIENT_TEMPLATE =
    `[Interface]\n` +
    `$MTU_LINE` +
    `Address = $CLIENT_ADDRESS/32\n` +
    `DNS = $PRIMARY_DNS, $SECONDARY_DNS\n` +
    `PrivateKey = $CLIENT_PRIVATE_KEY\n` +
    `Jc = $JC\n` +
    `Jmin = $JMIN\n` +
    `Jmax = $JMAX\n` +
    `S1 = $S1\n` +
    `S2 = $S2\n` +
    `S3 = $S3\n` +
    `S4 = $S4\n` +
    `H1 = $H1\n` +
    `H2 = $H2\n` +
    `H3 = $H3\n` +
    `H4 = $H4\n` +
    `I1 = $I1\n` +
    `I2 = $I2\n` +
    `I3 = $I3\n` +
    `I4 = $I4\n` +
    `I5 = $I5\n` +
    `HeaderProtectionKey = $HEADER_PROTECTION_KEY\n` +
    `ContentPaddingAddition = $CONTENT_PADDING_ADDITION\n` +
    `RekeyAfterTime = $REKEY_AFTER_TIME\n` +
    `RekeyTimeout = $REKEY_TIMEOUT\n` +
    `RejectAfterTime = $REJECT_AFTER_TIME\n` +
    `KeepaliveTimeout = $KEEPALIVE_TIMEOUT\n` +
    `MaxHandshakeAttempts = $MAX_HANDSHAKE_ATTEMPTS\n` +
    `RandomTrailers = $RANDOM_TRAILERS\n` +
    `DisableCookies = $DISABLE_COOKIES\n\n` +
    `[Peer]\n` +
    `PublicKey = $SERVER_PUBLIC_KEY\n` +
    `PresharedKey = $PRESHARED_KEY\n` +
    `AllowedIPs = 0.0.0.0/0, ::/0\n` +
    `$ENDPOINT_LINE` +
    `PersistentKeepalive = $PERSISTENT_KEEPALIVE\n`;

  // AmneziaWG parameter placeholders in the template
  private static readonly PARAM_PLACEHOLDERS: Record<string, string> = {
    Jc: "$JC",
    Jmin: "$JMIN",
    Jmax: "$JMAX",
    S1: "$S1",
    S2: "$S2",
    S3: "$S3",
    S4: "$S4",
    H1: "$H1",
    H2: "$H2",
    H3: "$H3",
    H4: "$H4",
    I1: "$I1",
    I2: "$I2",
    I3: "$I3",
    I4: "$I4",
    I5: "$I5",
    HeaderProtectionKey: "$HEADER_PROTECTION_KEY",
    ContentPaddingAddition: "$CONTENT_PADDING_ADDITION",
    RekeyAfterTime: "$REKEY_AFTER_TIME",
    RekeyTimeout: "$REKEY_TIMEOUT",
    RejectAfterTime: "$REJECT_AFTER_TIME",
    KeepaliveTimeout: "$KEEPALIVE_TIMEOUT",
    MaxHandshakeAttempts: "$MAX_HANDSHAKE_ATTEMPTS",
    RandomTrailers: "$RANDOM_TRAILERS",
    DisableCookies: "$DISABLE_COOKIES",
  };

  constructor(amneziaWg3: IAmneziaConnection) {
    super(amneziaWg3);
  }

  protected get protocol(): Protocol {
    return Protocol.AMNEZIAWG3;
  }

  protected get protocolDisplayName(): string {
    return "AmneziaWG3";
  }

  // Modern AmneziaVPN labels the `amnezia-awg` container "AmneziaWG Legacy" and
  // only `amnezia-awg2` as plain "AmneziaWG". The 2.0/3.1 distinction is carried
  // by `protocol_version` (here "3.1"), NOT the container id — so use the modern
  // id to avoid the misleading "Legacy" tag. Unrelated to the server-side Docker
  // container (`amnezia-awg3`, see AppContract.AmneziaWG3.DOCKER_CONTAINER).
  protected get clientContainerName(): string {
    return "amnezia-awg2";
  }

  protected get paths(): AmneziaWgPaths {
    return AppContract.AmneziaWG3.PATHS;
  }

  protected get transport(): string {
    return AppContract.AmneziaWG3.DEFAULTS.TRANSPORT;
  }

  protected override async formatActivePeerAllowedIps(
    assignedIpv4: string,
    serverConfig: string,
  ): Promise<string> {
    const raw = await this.connection.readFile(
      AppContract.AmneziaWG3.PATHS.IPV6_REJECT_STUB_ENV,
    );
    const persisted = parseIpv6RejectStubEnv(raw);
    if (!persisted.enabled) {
      return `${assignedIpv4}/32`;
    }

    const prefix = persisted.prefix ?? DEFAULT_IPV6_REJECT_STUB_PREFIX;
    const serverCidr = extractServerIpv4Cidr(serverConfig);
    const peerIpv6 = deriveStubPeerIpv6(assignedIpv4, serverCidr, prefix);
    return peerIpv6
      ? `${assignedIpv4}/32, ${peerIpv6}/128`
      : `${assignedIpv4}/32`;
  }

  private async readIpv6SysctlSupport(): Promise<boolean> {
    const iface = AppContract.AmneziaWG3.INTERFACE;
    const [forwardingRaw, disableRaw] = await Promise.all([
      this.connection.readFile("/proc/sys/net/ipv6/conf/all/forwarding"),
      this.connection.readFile(`/proc/sys/net/ipv6/conf/${iface}/disable_ipv6`),
    ]);
    return forwardingRaw.trim() === "1" && disableRaw.trim() === "0";
  }

  private async hasLiveIpv6RejectStub(prefix: string): Promise<boolean> {
    const serverIpv6 = deriveStubServerIpv6(prefix);
    if (!serverIpv6) return false;

    const iface = AppContract.AmneziaWG3.INTERFACE;
    const [addrResult, routeGetResult, routeShowResult] = await Promise.all([
      this.connection.run(`ip -6 -o addr show dev ${iface} 2>/dev/null || true`),
      this.connection.run(
        `ip -6 route get ${IPV6_REJECT_PROBE_TARGET} 2>&1 || true`,
      ),
      this.connection.run("ip -6 route show 2000::/3 2>/dev/null || true"),
    ]);

    const escaped = serverIpv6.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hasServerAddr = new RegExp(`(?:^|\\s)${escaped}/64(?:\\s|$)`).test(
      addrResult.stdout,
    );
    // Check both live route resolution (`route get`) and the FIB entry (`route
    // show 2000::/3`) so kernels/iproute2 builds that return EACCES without
    // echoing "prohibit" on `route get` still confirm the active prohibit rule.
    const hasProhibitRoute =
      /\bprohibit\b/i.test(routeGetResult.stdout) ||
      /\bprohibit\b/i.test(routeShowResult.stdout);
    return hasServerAddr && hasProhibitRoute;
  }

  /**
   * Read persisted and live kernel status of the AWG 3.1 IPv6 active-reject stub.
   */
  async getIpv6RejectStubStatus(): Promise<Ipv6RejectStubStatus> {
    const rawEnv = await this.connection.readFile(
      AppContract.AmneziaWG3.PATHS.IPV6_REJECT_STUB_ENV,
    );
    const persisted = parseIpv6RejectStubEnv(rawEnv);
    const prefix = persisted.prefix ?? DEFAULT_IPV6_REJECT_STUB_PREFIX;
    const supported = await this.readIpv6SysctlSupport();

    if (!supported) {
      return {
        supported: false,
        enabled: persisted.enabled,
        active: false,
        prefix,
        reason: "ipv6_forwarding_disabled",
      };
    }

    const active = await this.hasLiveIpv6RejectStub(prefix);
    const reason =
      persisted.enabled && !active
        ? "stub_route_missing"
        : !persisted.enabled && active
          ? "stub_route_present"
          : null;

    return {
      supported: true,
      enabled: persisted.enabled,
      active,
      prefix,
      reason,
    };
  }

  /**
   * Enable or disable the AWG 3.1 IPv6 active-reject stub live without dropping
   * IPv4 sessions. Serialized with peer mutations to prevent config races.
   */
  async setIpv6RejectStub(options: {
    enabled: boolean;
    prefix?: string;
  }): Promise<Ipv6RejectStubStatus> {
    return this.enqueueMutation(() => this.setIpv6RejectStubUnlocked(options));
  }

  private async setIpv6RejectStubUnlocked(options: {
    enabled: boolean;
    prefix?: string;
  }): Promise<Ipv6RejectStubStatus> {
    const rawEnv = await this.connection.readFile(
      AppContract.AmneziaWG3.PATHS.IPV6_REJECT_STUB_ENV,
    );
    const previous = parseIpv6RejectStubEnv(rawEnv);
    const normalizedPrefix =
      options.prefix !== undefined
        ? normalizeUla64Prefix(options.prefix)
        : (previous.prefix ?? DEFAULT_IPV6_REJECT_STUB_PREFIX);

    if (!normalizedPrefix) {
      throw new APIError(ClientErrorCode.BAD_REQUEST, {
        msg: "services.server.IPV6_STUB_INVALID_PREFIX",
      });
    }

    const iface = AppContract.AmneziaWG3.INTERFACE;
    const serverIpv6 = deriveStubServerIpv6(normalizedPrefix);
    if (!serverIpv6) {
      throw new APIError(ClientErrorCode.BAD_REQUEST, {
        msg: "services.server.IPV6_STUB_INVALID_PREFIX",
      });
    }

    if (options.enabled) {
      const supported = await this.readIpv6SysctlSupport();
      if (!supported) {
        throw new APIError(ClientErrorCode.CONFLICT, {
          msg: "services.server.IPV6_STUB_UNSUPPORTED",
        });
      }

      if (previous.prefix && previous.prefix !== normalizedPrefix) {
        const prevServerIpv6 = deriveStubServerIpv6(previous.prefix);
        if (prevServerIpv6) {
          await this.connection.run(
            `ip -6 address del ${prevServerIpv6}/64 dev ${iface} 2>/dev/null || true`,
          );
        }
      }

      await this.connection.run(
        `ip -6 address replace ${serverIpv6}/64 dev ${iface} nodad`,
      );
      await this.connection.run("ip -6 route replace prohibit 2000::/3");

      const live = await this.hasLiveIpv6RejectStub(normalizedPrefix);
      if (!live) {
        await this.connection.run(
          "ip -6 route del prohibit 2000::/3 2>/dev/null || true",
        );
        await this.connection.run(
          `ip -6 address del ${serverIpv6}/64 dev ${iface} 2>/dev/null || true`,
        );
        throw new Error(
          "Kernel did not confirm active IPv6 prohibit route on awg0",
        );
      }

      const wgConfig = await this.connection.readWgConfig();
      const rewritten = rewriteAwg3PeersForIpv6RejectStub(wgConfig, {
        enabled: true,
        prefix: normalizedPrefix,
      });
      if (rewritten.changed) {
        await this.connection.writeWgConfig(rewritten.config);
        await this.connection.syncWgConfig();
      }

      await this.connection.writeFile(
        AppContract.AmneziaWG3.PATHS.IPV6_REJECT_STUB_ENV,
        formatIpv6RejectStubEnv(true, normalizedPrefix),
      );

      return {
        supported: true,
        enabled: true,
        active: true,
        prefix: normalizedPrefix,
        reason: null,
      };
    }

    // Disabling: revert peer AllowedIPs back to IPv4-only first, then clean up
    // the kernel prohibit route and server ULA address without disrupting IPv4.
    const wgConfig = await this.connection.readWgConfig();
    const rewritten = rewriteAwg3PeersForIpv6RejectStub(wgConfig, {
      enabled: false,
      prefix: normalizedPrefix,
    });
    if (rewritten.changed) {
      await this.connection.writeWgConfig(rewritten.config);
      await this.connection.syncWgConfig();
    }

    await this.connection.run(
      "ip -6 route del prohibit 2000::/3 2>/dev/null || true",
    );
    const serverAddresses = new Set<string>([serverIpv6]);
    if (previous.prefix) {
      const prevServerIpv6 = deriveStubServerIpv6(previous.prefix);
      if (prevServerIpv6) serverAddresses.add(prevServerIpv6);
    }
    for (const addr of serverAddresses) {
      await this.connection.run(
        `ip -6 address del ${addr}/64 dev ${iface} 2>/dev/null || true`,
      );
    }

    await this.connection.writeFile(
      AppContract.AmneziaWG3.PATHS.IPV6_REJECT_STUB_ENV,
      formatIpv6RejectStubEnv(false, normalizedPrefix),
    );

    const supported = await this.readIpv6SysctlSupport();
    return {
      supported,
      enabled: false,
      active: false,
      prefix: normalizedPrefix,
      reason: supported ? null : "ipv6_forwarding_disabled",
    };
  }

  /**
   * Build the AmneziaWG 3.1 client config from the server configuration.
   */
  protected buildClientArtifacts(input: ClientArtifactInput): ClientArtifacts {
    const {
      serverConfig: config,
      assignedIp,
      clientPrivateKey,
      serverPublicKey,
      psk,
      listenPort,
      endpointHost,
    } = input;

    const awgParams = parseAwgParams(config);

    // The parameter set determines the version: 3.1 adds header protection,
    // timing randomization and trailers
    const isV3 = resolveAwgVersion(awgParams) === AwgVersion.V3_1;

    // Defaults are only for 2.0: in 3.1 the server owns the full set,
    // and extra values would break the handshake
    if (!isV3) {
      for (const [key, value] of Object.entries(
        AppContract.AmneziaWG3.PARAM_DEFAULTS,
      )) {
        awgParams[key] ||= value;
      }
    }

    // In 3.1 PersistentKeepalive is a range
    const keepAlive = isV3
      ? AppContract.AmneziaWG3.DEFAULTS.KEEPALIVE_V3
      : AppContract.AmneziaWG3.DEFAULTS.KEEPALIVE;
    const mtu = isV3 ? AppContract.AmneziaWG3.DEFAULTS.MTU : AppContract.AmneziaWG2.DEFAULTS.MTU;

    const primaryDns = AppContract.DNS.PRIMARY;
    const secondaryDns = AppContract.DNS.SECONDARY;

    let configText = AmneziaWg3Service.CLIENT_TEMPLATE.replace(
      "$MTU_LINE",
      isV3 ? `MTU = ${mtu}\n` : "",
    ).replace(
      /\$CLIENT_ADDRESS/g,
      assignedIp,
    )
      .replace(/\$PRIMARY_DNS/g, primaryDns)
      .replace(/\$SECONDARY_DNS/g, secondaryDns)
      .replace(/\$CLIENT_PRIVATE_KEY/g, clientPrivateKey)
      .replace(/\$SERVER_PUBLIC_KEY/g, serverPublicKey)
      .replace(/\$PRESHARED_KEY/g, psk)
      .replace(
        /\$ENDPOINT_LINE/g,
        endpointHost && listenPort
          ? `Endpoint = ${endpointHost}:${listenPort}\n`
          : "",
      )
      .replace(/\$PERSISTENT_KEEPALIVE/g, keepAlive);

    for (const [key, placeholder] of Object.entries(
      AmneziaWg3Service.PARAM_PLACEHOLDERS,
    )) {
      configText = configText.replaceAll(placeholder, () => awgParams[key]);
    }

    configText = dropEmptyConfigLines(configText);

    // JSON params: the Amnezia client keeps empty I1-I5
    // and omits the remaining unset parameters
    const jsonParams = Object.fromEntries(
      Object.keys(AmneziaWg3Service.PARAM_PLACEHOLDERS)
        .filter((key) => awgParams[key] || AWG_SPECIAL_JUNK_KEYS.includes(key))
        .map((key) => [key, awgParams[key]]),
    );

    return {
      configText,
      jsonParams,
      protocolVersion: isV3 ? AwgVersion.V3_1 : AwgVersion.V2,
      keepAlive,
      mtu,
    };
  }
}

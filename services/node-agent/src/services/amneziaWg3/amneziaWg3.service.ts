import { Protocol } from "@/types/shared";
import { AwgVersion } from "@/types/amnezia";
import { AppContract } from "@/contracts/app";
import { IAmneziaConnection } from "@/types/amnezia";
import {
  parseAwgParams,
  resolveAwgVersion,
  dropEmptyConfigLines,
  AWG_SPECIAL_JUNK_KEYS,
} from "@/helpers/awgConfig";
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
    const mtu = AppContract.AmneziaWG3.DEFAULTS.MTU;

    const primaryDns = AppContract.DNS.PRIMARY;
    const secondaryDns = AppContract.DNS.SECONDARY;

    let configText = AmneziaWg3Service.CLIENT_TEMPLATE.replace(
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

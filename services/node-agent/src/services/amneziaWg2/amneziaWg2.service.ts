import { Protocol } from "@/types/shared";
import { AppContract } from "@/contracts/app";
import { IAmneziaConnection } from "@/types/amnezia";
import {
  AmneziaWgPaths,
  ClientArtifacts,
  ClientArtifactInput,
  AmneziaWgServiceBase,
} from "@/services/amneziaWgShared";

/**
 * AmneziaWG 2.0 service.
 */
export class AmneziaWg2Service extends AmneziaWgServiceBase {
  static key = "amneziaWg2Service";

  constructor(amneziaWg2: IAmneziaConnection) {
    super(amneziaWg2);
  }

  protected get protocol(): Protocol {
    return Protocol.AMNEZIAWG2;
  }

  protected get protocolDisplayName(): string {
    return "AmneziaWG2";
  }

  // The official AmneziaVPN client expects the amnezia-awg container id
  protected get clientContainerName(): string {
    return "amnezia-awg";
  }

  protected get paths(): AmneziaWgPaths {
    return AppContract.AmneziaWG2.PATHS;
  }

  protected get transport(): string {
    return AppContract.AmneziaWG2.DEFAULTS.TRANSPORT;
  }

  /**
   * Build the AmneziaWG 2.0 client config from the server configuration.
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

    const isValidI2I5 = (val: string) =>
      val &&
      !val.includes("#") &&
      !val.includes("[Peer]") &&
      !/^\s*$/.test(val);

    const getVal = (key: string) => {
      const direct =
        config.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, "mi"))?.[1] ||
        "";
      if (direct) {
        if (["I2", "I3", "I4", "I5"].includes(key) && !isValidI2I5(direct))
          return "";
        return direct;
      }

      const commented =
        config
          .match(new RegExp(`^\\s*#\\s*${key}\\s*=\\s*(.*?)\\s*$`, "mi"))?.[1]
          ?.trim() || "";

      if (["I2", "I3", "I4", "I5"].includes(key) && !isValidI2I5(commented))
        return "";

      // Defaults for the case where the server config
      // contains empty/uninitialized values
      if (!commented) {
        if (key === "S3") return "20";
        if (key === "S4") return "23";
        if (key === "I1")
          return "<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>";
      }

      return commented;
    };

    const awgParams = {
      Jc: getVal("Jc"),
      Jmin: getVal("Jmin"),
      Jmax: getVal("Jmax"),
      S1: getVal("S1"),
      S2: getVal("S2"),
      S3: getVal("S3"),
      S4: getVal("S4"),
      H1: getVal("H1"),
      H2: getVal("H2"),
      H3: getVal("H3"),
      H4: getVal("H4"),
      I1: getVal("I1"),
      I2: getVal("I2"),
      I3: getVal("I3"),
      I4: getVal("I4"),
      I5: getVal("I5"),
    } as const;

    const primaryDns = AppContract.DNS.PRIMARY;
    const secondaryDns = AppContract.DNS.SECONDARY;
    const keepAlive = AppContract.AmneziaWG2.DEFAULTS.KEEPALIVE;
    const mtu = AppContract.AmneziaWG2.DEFAULTS.MTU;

    const initPacketLines = [
      awgParams.I1 ? `I1 = ${awgParams.I1}\n` : "",
      awgParams.I2 ? `I2 = ${awgParams.I2}\n` : "",
      awgParams.I3 ? `I3 = ${awgParams.I3}\n` : "",
      awgParams.I4 ? `I4 = ${awgParams.I4}\n` : "",
      awgParams.I5 ? `I5 = ${awgParams.I5}\n` : "",
    ]
      .filter(Boolean)
      .join("");

    const configText =
      `[Interface]\n` +
      `Address = ${assignedIp}/32\n` +
      `DNS = ${primaryDns}, ${secondaryDns}\n` +
      `PrivateKey = ${clientPrivateKey}\n` +
      `Jc = ${awgParams.Jc}\n` +
      `Jmin = ${awgParams.Jmin}\n` +
      `Jmax = ${awgParams.Jmax}\n` +
      `S1 = ${awgParams.S1}\n` +
      `S2 = ${awgParams.S2}\n` +
      `S3 = ${awgParams.S3}\n` +
      `S4 = ${awgParams.S4}\n` +
      `H1 = ${awgParams.H1}\n` +
      `H2 = ${awgParams.H2}\n` +
      `H3 = ${awgParams.H3}\n` +
      `H4 = ${awgParams.H4}\n` +
      (initPacketLines ? `${initPacketLines}` : "") +
      `\n[Peer]\n` +
      `PublicKey = ${serverPublicKey}\n` +
      `PresharedKey = ${psk}\n` +
      `AllowedIPs = 0.0.0.0/0, ::/0\n` +
      (endpointHost && listenPort
        ? `Endpoint = ${endpointHost}:${listenPort}\n`
        : "") +
      `PersistentKeepalive = ${keepAlive}\n`;

    const jsonParams = Object.fromEntries(
      Object.entries(awgParams).filter(
        ([, val]) => typeof val === "string" && val.trim().length > 0,
      ),
    );

    return {
      configText,
      jsonParams,
      protocolVersion: "2",
      keepAlive,
      mtu,
    };
  }
}

import {
  ClientPeer,
  PeerStatus,
  ClientRecord,
  CreateClientResult,
} from "@/types/clients";
import { APIError } from "@/utils/APIError";
import appConfig from "@/constants/appConfig";
import { AppContract } from "@/contracts/app";
import { AmneziaBackupData } from "@/types/server";
import { Protocol, ClientErrorCode } from "@/types/shared";
import { encodeVpnConfig } from "@/helpers/encodeVpnConfig";
import { allocatePeerIp } from "@/helpers/allocatePeerIp";
import { countDumpPeers, parseListenPort } from "@/helpers/hostMetrics";
import { ClientTableEntry, IAmneziaConnection } from "@/types/amnezia";

/**
 * File paths a versioned AmneziaWG service reads directly from its container.
 */
export interface AmneziaWgPaths {
  SERVER_PUBLIC_KEY: string;
  WG_PSK: string;
}

/**
 * Inputs a subclass receives to render the version-specific client config.
 */
export interface ClientArtifactInput {
  serverConfig: string;
  assignedIp: string;
  clientPrivateKey: string;
  clientId: string;
  serverPublicKey: string;
  psk: string;
  listenPort: string;
  endpointHost: string;
}

/**
 * Version-specific pieces produced by a subclass for a client config.
 */
export interface ClientArtifacts {
  configText: string;
  jsonParams: Record<string, string>;
  protocolVersion: string;
  keepAlive: string;
  mtu: string;
}

/**
 * Shared AmneziaWG service: peer lifecycle, backups and inventory.
 * Version-specific client config generation lives in buildClientArtifacts.
 */
export abstract class AmneziaWgServiceBase {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(protected readonly connection: IAmneziaConnection) {}

  /** Protocol identifier stamped on peers and results. */
  protected abstract get protocol(): Protocol;

  /** Human-readable protocol name used in the vpn:// description. */
  protected abstract get protocolDisplayName(): string;

  /** Container name the official AmneziaVPN client expects in the payload. */
  protected abstract get clientContainerName(): string;

  /** Container file paths this service reads directly. */
  protected abstract get paths(): AmneziaWgPaths;

  /** Transport used in the vpn:// payload. */
  protected abstract get transport(): string;

  /** Render the version-specific client config text and JSON params. */
  protected abstract buildClientArtifacts(
    input: ClientArtifactInput,
  ): ClientArtifacts;

  /**
   * Serialize mutating operations so parallel writes never clobber each other.
   */
  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Check that a [Peer] section belongs to the client with the given publicKey.
   */
  private isPeerSection(section: string, clientId: string): boolean {
    return section.match(/PublicKey\s*=\s*([^\s]+)/i)?.[1] === clientId;
  }

  /**
   * Get AllowedIPs for a peer.
   */
  private getPeerAllowedIps(config: string, clientId: string): string | null {
    const sections = config.split("[Peer]");

    for (const section of sections) {
      if (!this.isPeerSection(section, clientId)) {
        continue;
      }

      const match = section.match(/AllowedIPs\s*=\s*([^\n]+)/i);
      return match?.[1]?.trim() || null;
    }

    return null;
  }

  /**
   * Update AllowedIPs for a peer.
   */
  private updatePeerAllowedIps(
    config: string,
    clientId: string,
    allowedIps: string,
  ): string {
    const sections = config.split("[Peer]");
    let changed = false;

    const updatedSections = sections.map((section) => {
      if (!this.isPeerSection(section, clientId)) {
        return section;
      }

      changed = true;

      if (/AllowedIPs\s*=/i.test(section)) {
        return section.replace(
          /AllowedIPs\s*=\s*([^\n]+)/i,
          `AllowedIPs = ${allowedIps}`,
        );
      }

      return section.replace(
        /PublicKey\s*=\s*([^\n]+)/i,
        (line) => `${line}\nAllowedIPs = ${allowedIps}`,
      );
    });

    return changed ? updatedSections.join("[Peer]") : config;
  }

  /**
   * What this protocol's interface is actually doing right now, for the panel's
   * node card. `up` means the dump answered at all: a container that is down,
   * or an interface that never came up, throws from the connection rather than
   * returning an empty dump, and the caller must be able to tell that apart
   * from an interface with no peers.
   *
   * This lives on the service rather than in the caller so nothing outside
   * reaches into `connection`, which is protected for a reason.
   */
  async getInterfaceState(): Promise<{
    up: boolean;
    peers: number;
    listenPort: number | null;
  }> {
    try {
      const [dump, config] = await Promise.all([
        this.connection.getWgDump(),
        this.connection.readWgConfig().catch(() => ""),
      ]);
      return {
        up: true,
        peers: countDumpPeers(dump),
        listenPort: parseListenPort(config),
      };
    } catch {
      return { up: false, peers: 0, listenPort: null };
    }
  }

  /**
   * Export AmneziaWG data for a backup.
   */
  async exportBackup(): Promise<AmneziaBackupData> {
    const [wgConfig, clients, serverPublicKeyRaw, presharedKeyRaw] =
      await Promise.all([
        this.connection.readWgConfig(),
        this.connection.readClientsTable(),
        this.connection.readFile(this.paths.SERVER_PUBLIC_KEY),
        this.connection.readFile(this.paths.WG_PSK),
      ]);

    return {
      wgConfig,
      clients,
      serverPublicKey: serverPublicKeyRaw.trim(),
      presharedKey: presharedKeyRaw.trim(),
    };
  }

  /**
   * Import AmneziaWG data from a backup.
   */
  async importBackup(data: AmneziaBackupData): Promise<void> {
    return this.enqueueMutation(() => this.importBackupUnlocked(data));
  }

  private async importBackupUnlocked(data: AmneziaBackupData): Promise<void> {
    await this.connection.writeWgConfig(data.wgConfig);
    await this.connection.writeClientsTable(data.clients);
    await this.connection.writeFile(
      this.paths.WG_PSK,
      `${data.presharedKey.trim()}\n`,
    );
    await this.connection.writeFile(
      this.paths.SERVER_PUBLIC_KEY,
      `${data.serverPublicKey.trim()}\n`,
    );
    await this.connection.syncWgConfig();
  }

  /**
   * List clients from the persisted configuration and the live dump.
   */
  async getClients(): Promise<ClientRecord[]> {
    const [config, dump, clientsTable] = await Promise.all([
      this.connection.readWgConfig(),
      this.connection.getWgDump(),
      this.connection.readClientsTable(),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const userData: Record<
      string,
      { name: string; peerNames: string[]; expiresAt?: number }
    > = {};
    for (const client of clientsTable) {
      const clientKey = client?.clientId;
      const clientName = client?.userData?.clientName;
      const expiresAt = client.userData?.expiresAt;
      if (!clientKey || !clientName) continue;
      const nameMatch = clientName.match(/^\s*(.*?)\s*(?:\[(.*)\])?\s*$/);
      const userName = (nameMatch?.[1] || clientName).trim();
      const peerName = (nameMatch?.[2] || "").trim();
      if (!userData[clientKey]) {
        userData[clientKey] = {
          name: userName,
          peerNames: [],
          expiresAt,
        };
      }
      if (peerName && !userData[clientKey].peerNames.includes(peerName)) {
        userData[clientKey].peerNames.push(peerName);
      }
      if (expiresAt) {
        userData[clientKey].expiresAt = expiresAt;
      }
    }
    const runtimeStats = new Map<
      string,
      {
        endpoint: string | null;
        lastHandshake: number;
        received: number;
        sent: number;
      }
    >();
    for (const line of dump.split("\n")) {
      const parts = line.trim().split("\t");
      if (parts.length < 7 || !parts[0]) continue;
      const rawHandshake = Number(parts[4]) || 0;
      runtimeStats.set(parts[0], {
        endpoint: parts[2] && parts[2] !== "(none)" ? parts[2] : null,
        lastHandshake:
          rawHandshake > AppContract.WG.HANDSHAKE_NANO_THRESHOLD
            ? Math.floor(rawHandshake / 1_000_000_000)
            : rawHandshake,
        received: Number(parts[5]) || 0,
        sent: Number(parts[6]) || 0,
      });
    }
    const peerEntries: (ClientPeer & { username: string })[] = [];
    for (const match of config.matchAll(
      /\[Peer\]([\s\S]*?)(?=\n\s*\[Peer\]|$)/gi,
    )) {
      const section = match[1] ?? "";
      const id = section.match(/^\s*PublicKey\s*=\s*([^\s]+)\s*$/im)?.[1];
      if (!id) continue;
      const allowedIps =
        section
          .match(/^\s*AllowedIPs\s*=\s*([^\n]+)$/im)?.[1]
          ?.split(",")
          .map((value) => value.trim())
          .filter(Boolean) ?? [];
      const stats = runtimeStats.get(id) ?? {
        endpoint: null,
        lastHandshake: 0,
        received: 0,
        sent: 0,
      };
      const username = userData[id]?.name || id;
      const blocked =
        allowedIps.length === 1 && allowedIps[0] === "0.0.0.0/32";
      peerEntries.push({
        username,
        id,
        name: userData[id]?.peerNames?.[0] ?? null,
        allowedIps,
        lastHandshake: stats.lastHandshake,
        traffic: { received: stats.received, sent: stats.sent },
        endpoint: stats.endpoint,
        online:
          stats.lastHandshake > 0 &&
          now - stats.lastHandshake < AppContract.WG.ONLINE_THRESHOLD_SECONDS,
        expiresAt: userData[id]?.expiresAt || null,
        status: blocked ? PeerStatus.Disabled : PeerStatus.Active,
        protocol: this.protocol,
      });
    }
    const users = new Map<string, ClientRecord>();
    for (const { username, ...peer } of peerEntries) {
      const entry = users.get(username) || {
        username,
        peers: [],
      };
      entry.peers.push(peer);
      users.set(username, entry);
    }
    return Array.from(users.values());
  }

  /**
   * Create a new client.
   */
  async createClient(
    clientName: string,
    options?: { expiresAt?: number | null },
  ): Promise<CreateClientResult> {
    return this.enqueueMutation(() =>
      this.createClientUnlocked(clientName, options),
    );
  }

  private async createClientUnlocked(
    clientName: string,
    options?: { expiresAt?: number | null },
  ): Promise<CreateClientResult> {
    // Enforce the maximum peer count
    const maxPeers = appConfig.SERVER_MAX_PEERS;
    if (maxPeers) {
      const clients = await this.getClients();

      const currentPeers = clients.reduce(
        (acc, client) => acc + client.peers.length,
        0,
      );

      if (currentPeers >= maxPeers) {
        throw new APIError(ClientErrorCode.CONFLICT);
      }
    }

    // Generate the client private key
    const clientPrivateKey = (
      await this.connection.run(`awg genkey`)
    ).stdout.trim();

    // Generate the client public key
    const clientId = (
      await this.connection.run(`echo '${clientPrivateKey}' | awg pubkey`)
    ).stdout.trim();

    // Read the server config
    const config = await this.connection.readWgConfig();

    const serverCidr = config.match(
      /^\s*Address\s*=\s*([0-9]+(?:\.[0-9]+){3}\/\d+)\s*$/im,
    )?.[1];
    const usedPeerCidrs = Array.from(
      config.matchAll(/^\s*AllowedIPs\s*=\s*([^\n]+)$/gim),
      (match) => match[1]?.trim() ?? "",
    );
    const assignedIp = serverCidr
      ? allocatePeerIp(serverCidr, usedPeerCidrs)
      : null;

    if (!assignedIp) {
      throw new APIError(ClientErrorCode.CONFLICT, {
        msg: "swagger.errors.NO_FREE_IP",
      });
    }

    // Read the PSK
    const psk = (
      await this.connection.run(
        `cat ${this.paths.WG_PSK} 2>/dev/null || true`,
      )
    ).stdout.trim();

    // Add the peer to the config
    const peerPskLine = `PresharedKey = ${psk}\n`;
    const peerSection = `\n[Peer]\nPublicKey = ${clientId}\n${peerPskLine}AllowedIPs = ${assignedIp}/32\n`;

    // Assemble the new config
    const newConfig =
      (config.endsWith("\n") ? config : config + "\n") + peerSection;

    const table = await this.connection.readClientsTable();
    const configuredPeerIds = new Set(
      Array.from(
        config.matchAll(/^\s*PublicKey\s*=\s*([^\s]+)\s*$/gim),
        (match) => match[1],
      ),
    );
    const existingManagedPeer = table.find((entry) => {
      const entryId = (entry?.clientId || entry?.publicKey || "").trim();
      return (
        entry?.userData?.clientName === clientName &&
        entryId.length > 0 &&
        configuredPeerIds.has(entryId)
      );
    });
    if (existingManagedPeer) {
      throw new APIError(ClientErrorCode.CONFLICT);
    }

    const creationDate = new Date().toString();
    const userData: ClientTableEntry["userData"] = {
      clientName,
      creationDate,
      allowedIp: assignedIp,
    };
    if (options?.expiresAt) {
      userData.expiresAt = options.expiresAt;
    }
    const nextTable = table.filter(
      (entry) => entry?.userData?.clientName !== clientName,
    );
    nextTable.push({ clientId, userData });

    // Persist the label before exposing the peer in the live config
    await this.connection.writeClientsTable(nextTable);
    await this.connection.writeWgConfig(newConfig);
    await this.connection.syncWgConfig();

    // Read the server public key
    const serverPublicKey = (
      await this.connection.run(
        `cat ${this.paths.SERVER_PUBLIC_KEY} 2>/dev/null || true`,
      )
    ).stdout.trim();

    // Read the listen port
    const listenPort =
      config.match(/\[Interface\][\s\S]*?ListenPort\s*=\s*(\d+)/i)?.[1] || "";

    // Read the endpoint host
    const endpointHost = appConfig.SERVER_PUBLIC_HOST || "";

    // Render the version-specific client artifacts
    const { configText, jsonParams, protocolVersion, keepAlive, mtu } =
      this.buildClientArtifacts({
        serverConfig: config,
        assignedIp,
        clientPrivateKey,
        clientId,
        serverPublicKey,
        psk,
        listenPort,
        endpointHost,
      });

    const primaryDns = AppContract.DNS.PRIMARY;
    const secondaryDns = AppContract.DNS.SECONDARY;

    // Embedded config used by the client and re-exported by the panel
    const lastConfig = {
      ...jsonParams,
      allowed_ips: ["0.0.0.0/0", "::/0"],
      clientId: clientId,
      client_ip: `${assignedIp}`,
      client_priv_key: clientPrivateKey,
      client_pub_key: clientId,
      config: configText,
      hostName: endpointHost,
      mtu,
      persistent_keep_alive: keepAlive,
      port: listenPort ? Number(listenPort) : undefined,
      psk_key: psk,
      server_pub_key: serverPublicKey,
    } as Record<string, unknown>;

    // AWG container payload
    const awg = {
      ...jsonParams,
      protocol_version: protocolVersion,
      last_config: JSON.stringify(lastConfig, null, 2),
      port: String(listenPort || ""),
      transport_proto: this.transport,
    };

    // Supported placeholders in appConfig.SERVER_NAME:
    // {protocol} - connection protocol (e.g. "AmneziaWG")
    // {username} - client name (clientName)
    const baseServerName = appConfig.SERVER_NAME || "";
    const protocolName = this.protocolDisplayName;
    let description = baseServerName;

    if (/\{protocol\}|\{username\}/i.test(baseServerName)) {
      description = baseServerName
        .replace(/\{protocol\}/gi, protocolName)
        .replace(/\{username\}/gi, clientName);
    } else if (!baseServerName) {
      description = `${clientName} | ${protocolName}`;
    }

    // Server JSON (the official AmneziaVPN client expects the amnezia-awg container)
    const serverJson = {
      containers: [
        {
          awg,
          container: this.clientContainerName,
        },
      ],
      defaultContainer: this.clientContainerName,
      description,
      dns1: primaryDns,
      dns2: secondaryDns,
      hostName: endpointHost,
    };

    // Encode the config into vpn:// for import into the app
    const clientConfig = encodeVpnConfig(serverJson);

    return {
      id: clientId,
      config: clientConfig,
      protocol: this.protocol,
    };
  }

  /**
   * Update a client's expiresAt / status.
   */
  async updateClient(
    clientId: string,
    options: { expiresAt?: number | null; status?: PeerStatus },
  ): Promise<boolean> {
    return this.enqueueMutation(() =>
      this.updateClientUnlocked(clientId, options),
    );
  }

  private async updateClientUnlocked(
    clientId: string,
    options: { expiresAt?: number | null; status?: PeerStatus },
  ): Promise<boolean> {
    const table = await this.connection.readClientsTable();

    const entry = table.find(
      (x) => ((x && (x.clientId || x.publicKey)) || "") === clientId,
    );

    if (!entry) return false;

    const userData = entry.userData ?? {};
    const now = Math.floor(Date.now() / 1000);

    if (options.expiresAt !== undefined) {
      if (options.expiresAt === null) {
        delete userData.expiresAt;
      } else {
        userData.expiresAt = options.expiresAt;
      }
    }

    entry.userData = userData;
    await this.connection.writeClientsTable(table);

    const config = await this.connection.readWgConfig();
    if (config) {
      const currentAllowedIps = this.getPeerAllowedIps(config, clientId);

      if (
        !userData.allowedIp &&
        currentAllowedIps &&
        currentAllowedIps !== "0.0.0.0/32"
      ) {
        const firstIp = currentAllowedIps.split(",")[0].trim();
        userData.allowedIp = firstIp.includes("/")
          ? firstIp.split("/")[0]
          : firstIp;
        entry.userData = userData;
        await this.connection.writeClientsTable(table);
      }

      const isExpired =
        typeof userData.expiresAt === "number" && userData.expiresAt <= now;
      const targetStatus =
        options.status ??
        (options.expiresAt !== undefined
          ? isExpired
            ? PeerStatus.Disabled
            : PeerStatus.Active
          : null);

      const targetAllowedIps =
        targetStatus === PeerStatus.Disabled
          ? "0.0.0.0/32"
          : targetStatus === PeerStatus.Active
            ? userData.allowedIp
              ? userData.allowedIp.includes("/")
                ? userData.allowedIp
                : `${userData.allowedIp}/32`
              : null
            : null;

      if (targetAllowedIps && currentAllowedIps !== targetAllowedIps) {
        const newConfig = this.updatePeerAllowedIps(
          config,
          clientId,
          targetAllowedIps,
        );

        if (newConfig !== config) {
          await this.connection.writeWgConfig(newConfig);
          await this.connection.syncWgConfig();
        }
      }
    }

    return true;
  }

  /**
   * Delete a client.
   */
  async deleteClient(clientId: string): Promise<boolean> {
    return this.enqueueMutation(() => this.deleteClientUnlocked(clientId));
  }

  private async deleteClientUnlocked(clientId: string): Promise<boolean> {
    const table = await this.connection.readClientsTable();
    const nextTable = table.filter(
      (x) => ((x && (x.clientId || x.publicKey)) || "") !== clientId,
    );
    const hasTableEntry = nextTable.length < table.length;
    const config = await this.connection.readWgConfig();
    let nextConfig = config;

    if (config) {
      const sections = config.split("[Peer]");
      nextConfig = sections
        .filter((section) => !this.isPeerSection(section, clientId))
        .join("[Peer]");
    }

    const hasConfiguredPeer = nextConfig !== config;
    if (!hasTableEntry && !hasConfiguredPeer) return false;

    if (hasConfiguredPeer) {
      await this.connection.writeWgConfig(nextConfig);
    }
    await this.connection.syncWgConfig();
    if (hasTableEntry) {
      await this.connection.writeClientsTable(nextTable);
    }

    return true;
  }

  /**
   * Disable every expired client.
   * Entries are kept: peers get AllowedIPs = 0.0.0.0/32.
   */
  async disableExpiredClients(): Promise<number> {
    return this.enqueueMutation(() => this.disableExpiredClientsUnlocked());
  }

  private async disableExpiredClientsUnlocked(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);

    const table = await this.connection.readClientsTable();

    const expired = table.filter((entry) => {
      const expiresAt = entry?.userData?.expiresAt;
      return typeof expiresAt === "number" && expiresAt <= now;
    });

    if (!expired.length) return 0;

    const config = await this.connection.readWgConfig();
    let updatedConfig = config;
    let updatedTable = false;

    if (config) {
      for (const entry of expired) {
        const clientId = entry?.clientId?.trim();
        if (!clientId) continue;

        const userData = entry.userData ?? {};
        const currentAllowedIps = this.getPeerAllowedIps(config, clientId);

        if (
          !userData.allowedIp &&
          currentAllowedIps &&
          currentAllowedIps !== "0.0.0.0/32"
        ) {
          const firstIp = currentAllowedIps.split(",")[0].trim();
          userData.allowedIp = firstIp.includes("/")
            ? firstIp.split("/")[0]
            : firstIp;
          entry.userData = userData;
          updatedTable = true;
        }

        updatedConfig = this.updatePeerAllowedIps(
          updatedConfig,
          clientId,
          "0.0.0.0/32",
        );
      }
    }

    if (updatedTable) {
      await this.connection.writeClientsTable(table);
    }

    if (config && updatedConfig !== config) {
      await this.connection.writeWgConfig(updatedConfig);
      await this.connection.syncWgConfig();
    }

    return expired.length;
  }
}

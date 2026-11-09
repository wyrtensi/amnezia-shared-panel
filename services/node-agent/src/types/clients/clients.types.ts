import { Protocol } from "@/types/shared";

/**
 * Peer byte counters from the server's side, as `awg show dump` reports them:
 * `received` is what the server got from the device (the device's upload),
 * `sent` is what the server sent to the device (the device's download).
 */
export type TrafficStats = {
  received: number;
  sent: number;
};

export enum PeerStatus {
  Active = "active",
  Disabled = "disabled",
}

export type CreateClientPayload = {
  clientName: string;
  protocol: Protocol;
  expiresAt?: number | null;
};

export type DeleteClientPayload = {
  clientId: string;
  protocol: Protocol;
};

export type UpdateClientPayload = {
  clientId: string;
  protocol: Protocol;
  status?: PeerStatus;
  expiresAt?: number | null;
};

export type CreateClientResult = {
  id: string;
  config: string;
  protocol: Protocol;
};

export interface ClientPeer {
  id: string;
  name: string | null;
  allowedIps: string[];
  lastHandshake: number;
  traffic: TrafficStats;
  endpoint: string | null;
  online: boolean;
  expiresAt: number | null;
  status: PeerStatus;
  protocol: Protocol;
}

export interface ClientRecord {
  username: string;
  peers: ClientPeer[];
}

export interface ClientMutationOptions {
  expiresAt?: number | null;
  status?: PeerStatus;
}

export interface IProtocolService {
  getClients(): Promise<ClientRecord[]>;
  createClient(
    clientName: string,
    options?: { expiresAt?: number | null },
  ): Promise<CreateClientResult>;
  updateClient(
    clientId: string,
    options: ClientMutationOptions,
  ): Promise<boolean>;
  deleteClient(clientId: string): Promise<boolean>;
  disableExpiredClients(): Promise<number>;
}

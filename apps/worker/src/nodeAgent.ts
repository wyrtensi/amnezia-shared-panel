import { z } from "zod";
import type { ProtocolKind } from "@amnezia/contracts";

const protocolForAgent = (protocol: ProtocolKind): "amneziawg2" | "amneziawg3" =>
  protocol === "awg2" ? "amneziawg2" : "amneziawg3";

const AGENT_PROTOCOL_TO_KIND: Record<string, ProtocolKind> = {
  amneziawg2: "awg2",
  amneziawg3: "awg3",
};

/**
 * Map the node-agent's reported protocol identifiers to panel protocol kinds,
 * dropping any the panel does not model.
 */
export const protocolsFromAgent = (protocols: string[]): ProtocolKind[] => {
  const kinds = protocols
    .map((protocol) => AGENT_PROTOCOL_TO_KIND[protocol])
    .filter((protocol): protocol is ProtocolKind => Boolean(protocol));
  return [...new Set(kinds)];
};

const peerSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  allowedIps: z.array(z.string()),
  lastHandshake: z.number().nonnegative(),
  traffic: z.object({
    received: z.number().nonnegative(),
    sent: z.number().nonnegative(),
  }),
  endpoint: z.string().nullable(),
  online: z.boolean(),
  expiresAt: z.number().nullable(),
  status: z.string(),
  protocol: z.string(),
});
const clientRecordSchema = z.object({
  username: z.string(),
  peers: z.array(peerSchema),
});
const listResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(clientRecordSchema),
});
const createResponseSchema = z.object({
  client: z.object({
    id: z.string(),
    config: z.string().startsWith("vpn://"),
    protocol: z.string(),
  }),
});
const healthSchema = z.object({ ok: z.literal(true) });
const serverSchema = z.object({
  id: z.string(),
  region: z.string(),
  weight: z.number(),
  maxPeers: z.number().int().nonnegative(),
  totalPeers: z.number().int().nonnegative(),
  protocols: z.array(z.string()),
  // Reported by node-agents that expose SERVER_PUBLIC_HOST; absent on older
  // builds, so it must stay optional here or every poll against an old agent
  // would fail validation.
  publicHost: z.string().optional(),
  // The UDP ports the node reports listening on. Optional for the same reason:
  // an agent that predates the field must not fail the poll.
  listenPorts: z.array(z.number().int()).optional(),
});
const nullableMetricSchema = z.number().nonnegative().nullable();
const awgInterfaceSchema = z
  .object({
    up: z.boolean(),
    peers: z.number().int().nonnegative(),
  })
  .nullish();
const serverLoadSchema = z.object({
  timestamp: z.iso.datetime(),
  uptimeSec: z.number().nonnegative(),
  loadavg: z.tuple([z.number(), z.number(), z.number()]),
  cpu: z.object({ cores: z.number().int().positive() }),
  memory: z.object({
    totalBytes: z.number().nonnegative(),
    freeBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
    // MemAvailable. `.nullish()` and not `.nullable()`: an agent that predates
    // the field omits the key entirely, and that must parse rather than fail
    // the whole poll for a node that is otherwise perfectly healthy.
    availableBytes: z.number().nonnegative().nullish(),
  }),
  swap: z
    .object({
      totalBytes: z.number().nonnegative(),
      usedBytes: z.number().nonnegative().nullish(),
    })
    .nullish(),
  agent: z
    .object({
      pidsCurrent: z.number().int().nonnegative().nullish(),
      pidsMax: z.number().int().nonnegative().nullish(),
    })
    .nullish(),
  awg: z
    .object({
      amneziawg2: awgInterfaceSchema,
      amneziawg3: awgInterfaceSchema,
    })
    .nullish(),
  disk: z
    .object({
      totalBytes: z.number().nonnegative(),
      usedBytes: z.number().nonnegative(),
      availableBytes: z.number().nonnegative(),
      usedPercent: z.number().min(0).max(100),
    })
    .nullable(),
  network: z
    .object({
      rxBytes: z.number().nonnegative(),
      txBytes: z.number().nonnegative(),
    })
    .nullable(),
  docker: z
    .object({
      containers: z.array(
        z.object({
          name: z.string(),
          cpuPercent: nullableMetricSchema,
          memUsageBytes: nullableMetricSchema,
          memLimitBytes: nullableMetricSchema,
          netRxBytes: nullableMetricSchema,
          netTxBytes: nullableMetricSchema,
          pids: nullableMetricSchema,
        }),
      ),
    })
    .nullable(),
});

// GET /server/update. `available` is false on a node that was never wired for
// in-panel updates, and the whole object is absent on an agent too old to serve
// the route at all - both mean "this node cannot update itself from here".
const agentUpdateStatusSchema = z.object({
  available: z.boolean(),
  repository: z.string().nullable().optional(),
  state: z.enum(["idle", "requested", "running", "succeeded", "failed"]),
  image: z.string().nullable(),
  log: z.string(),
  updatedAt: z.string().nullable(),
  message: z.string().nullable().optional(),
});
const agentUpdateAcceptedSchema = z.object({
  id: z.string(),
  image: z.string(),
});

export type NodeClientRecord = z.infer<typeof clientRecordSchema>;
export type CreatedNodeClient = z.infer<typeof createResponseSchema>["client"];
export type NodeHealth = z.infer<typeof healthSchema>;
export type NodeServer = z.infer<typeof serverSchema>;
export type NodeServerLoad = z.infer<typeof serverLoadSchema>;
export type NodeAgentUpdateStatus = z.infer<typeof agentUpdateStatusSchema>;

export interface NodeAgent {
  getHealth: () => Promise<NodeHealth>;
  getServer: () => Promise<NodeServer>;
  getServerLoad: () => Promise<NodeServerLoad>;
  // null when this agent does not serve the route at all, i.e. it predates the
  // feature. That is not an error: it is the answer.
  getAgentUpdate: () => Promise<NodeAgentUpdateStatus | null>;
  requestAgentUpdate: (image: string) => Promise<{ id: string; image: string }>;
  listClients: () => Promise<NodeClientRecord[]>;
  createClient: (
    label: string,
    protocol: ProtocolKind,
  ) => Promise<CreatedNodeClient>;
  deleteClient: (publicKey: string, protocol: ProtocolKind) => Promise<void>;
  setClientStatus: (
    publicKey: string,
    protocol: ProtocolKind,
    status: "active" | "disabled",
  ) => Promise<void>;
}

export type NodeAgentClientOptions = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export const createNodeAgentClient = ({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}: NodeAgentClientOptions): NodeAgent => {
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": apiKey,
        ...init?.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`Node-agent request failed with status ${response.status}`);
    }
    if (response.status === 204) return null;
    return response.json() as Promise<unknown>;
  };

  return {
    getHealth: async () => healthSchema.parse(await request("/healthz")),
    getServer: async () => serverSchema.parse(await request("/server")),
    getServerLoad: async () =>
      serverLoadSchema.parse(await request("/server/load")),
    getAgentUpdate: async () => {
      try {
        return agentUpdateStatusSchema.parse(await request("/server/update"));
      } catch (error) {
        // An agent built before this feature answers 404, and one being
        // replaced right now answers nothing at all. Neither is a failure of
        // the poll that called this - the node simply has no answer yet.
        if (error instanceof Error && /status 404/.test(error.message)) return null;
        throw error;
      }
    },
    requestAgentUpdate: async (image) =>
      agentUpdateAcceptedSchema.parse(
        await request("/server/update", {
          method: "POST",
          body: JSON.stringify({ image }),
        }),
      ),
    listClients: async () => {
      const items: NodeClientRecord[] = [];
      let skip = 0;
      for (;;) {
        const page = listResponseSchema.parse(
          await request(`/clients?skip=${skip}&limit=100`),
        );
        items.push(...page.items);
        skip += page.items.length;
        if (skip >= page.total || page.items.length === 0) return items;
      }
    },
    createClient: async (label, protocol) => {
      const response = createResponseSchema.parse(
        await request("/clients", {
          method: "POST",
          body: JSON.stringify({
            clientName: label,
            protocol: protocolForAgent(protocol),
          }),
        }),
      );
      return response.client;
    },
    deleteClient: async (publicKey, protocol) => {
      await request("/clients", {
        method: "DELETE",
        body: JSON.stringify({
          clientId: publicKey,
          protocol: protocolForAgent(protocol),
        }),
      });
    },
    setClientStatus: async (publicKey, protocol, status) => {
      await request("/clients", {
        method: "PATCH",
        body: JSON.stringify({
          clientId: publicKey,
          protocol: protocolForAgent(protocol),
          status,
        }),
      });
    },
  };
};

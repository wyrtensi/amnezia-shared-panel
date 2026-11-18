import {
  probeCapabilitiesResponseSchema,
  probeRunStateSchema,
  type ProbeRunRequest,
  type ProbeRunState,
} from "@amnezia/contracts";

/** The worker's view of the reachability probe's loopback API. */
export type ProbeClient = {
  /** Start a run. `"busy"` when the probe is still running a previous one. */
  startRun: (request: ProbeRunRequest) => Promise<{ runId: string } | "busy">;
  /** The newest run, finished or not; null before the probe's first run. */
  latestRun: () => Promise<ProbeRunState | null>;
  /**
   * The probe's capability names. `"legacy"` when the probe has no capability
   * endpoint (404): it measures Direct paths only. Other failures throw, so a
   * probe that is merely down is not mistaken for a legacy one.
   */
  capabilities: () => Promise<{ apiVersion: number; capabilities: string[] } | "legacy">;
};

export type ProbeClientOptions = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export const createProbeClient = ({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}: ProbeClientOptions): ProbeClient => {
  const call = async (path: string, init?: RequestInit) => {
    try {
      return await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
      });
    } catch (error) {
      // An unusable header value comes back with the value quoted in the
      // message; this one ends up in the admin view, so it is replaced.
      if (error instanceof TypeError && /header/i.test(error.message)) {
        // No `cause` on purpose: the cause is the message that quotes the key.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("The stored probe API key is not a valid header value");
      }
      throw error;
    }
  };

  return {
    startRun: async (request) => {
      // The body carries service-key configs: it is sent, never logged.
      const response = await call("/runs", {
        method: "POST",
        body: JSON.stringify(request),
      });
      if (response.status === 409) return "busy";
      if (!response.ok) {
        throw new Error(`Probe refused the run with status ${response.status}`);
      }
      return { runId: request.runId };
    },
    latestRun: async () => {
      const response = await call("/runs/latest");
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Probe request failed with status ${response.status}`);
      }
      const parsed = probeRunStateSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Probe returned a malformed run");
      return parsed.data;
    },
    capabilities: async () => {
      const response = await call("/capabilities");
      if (response.status === 404) return "legacy";
      if (!response.ok) {
        throw new Error(`Probe capability request failed with status ${response.status}`);
      }
      const parsed = probeCapabilitiesResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Probe returned a malformed capability response");
      return parsed.data;
    },
  };
};

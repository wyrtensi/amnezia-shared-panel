import {
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
  const call = (path: string, init?: RequestInit) =>
    fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
    });

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
  };
};

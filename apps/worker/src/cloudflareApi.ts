/**
 * Minimal Cloudflare Access API client for the panel → Access allowlist sync.
 * Reads and updates one Access application policy's `include` rules. Endpoints
 * and shapes per docs/CLOUDFLARE-ACCESS.md (Account API token, Access: Apps and
 * Policies — Edit).
 */
export type CfAccessRule = Record<string, unknown> & {
  email?: { email: string };
};

export type CfAccessPolicy = {
  id: string;
  name?: string;
  decision?: string;
  include: CfAccessRule[];
  exclude?: CfAccessRule[];
  require?: CfAccessRule[];
};

export type CloudflareConfig = {
  accountId: string;
  appId: string;
  policyId: string;
  apiToken: string;
};

export interface CloudflareAccessClient {
  getPolicy(): Promise<CfAccessPolicy>;
  updatePolicy(policy: CfAccessPolicy): Promise<void>;
}

const API_BASE = "https://api.cloudflare.com/client/v4";

export function createCloudflareAccessClient(
  config: CloudflareConfig,
): CloudflareAccessClient {
  const url = `${API_BASE}/accounts/${config.accountId}/access/apps/${config.appId}/policies/${config.policyId}`;
  const headers = {
    authorization: `Bearer ${config.apiToken}`,
    "content-type": "application/json",
  };

  const check = async (res: Response, action: string) => {
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: unknown;
      errors?: unknown;
    };
    if (!res.ok || body.success === false) {
      const detail = JSON.stringify(body.errors ?? body).slice(0, 300);
      throw new Error(`Cloudflare ${action} failed (${res.status}): ${detail}`);
    }
    return body.result;
  };

  return {
    async getPolicy() {
      const result = await check(
        await fetch(url, { headers, signal: AbortSignal.timeout(30_000) }),
        "get policy",
      );
      return result as CfAccessPolicy;
    },
    async updatePolicy(policy) {
      // Cloudflare requires the full policy document (name + decision) and
      // treats a bare {include} as a replacement — so echo every read field
      // back to avoid a 400 or wiping exclude/require rules.
      await check(
        await fetch(url, {
          // App-scoped Access policies take PUT; PATCH returns 405
          // ("Method not allowed for this authentication scheme").
          method: "PUT",
          headers,
          body: JSON.stringify({
            name: policy.name,
            decision: policy.decision,
            include: policy.include,
            exclude: policy.exclude ?? [],
            require: policy.require ?? [],
          }),
          signal: AbortSignal.timeout(30_000),
        }),
        "update policy",
      );
    },
  };
}

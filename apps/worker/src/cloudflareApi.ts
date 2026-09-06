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
  /**
   * Reusable policies live on the account and may be attached to several
   * applications; app-scoped ones belong to a single application. Cloudflare
   * reports this on read and refuses a reusable policy written through the
   * application endpoint, so it decides where the update goes.
   */
  reusable?: boolean;
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
  // Two homes for the same policy. An app-scoped policy is only addressable
  // under its application; a reusable one is readable under either but writable
  // ONLY under the account (the application endpoint answers a write with
  // "can not update reusable policies through this endpoint").
  const appScopedUrl = `${API_BASE}/accounts/${config.accountId}/access/apps/${config.appId}/policies/${config.policyId}`;
  const accountScopedUrl = `${API_BASE}/accounts/${config.accountId}/access/policies/${config.policyId}`;
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
      // 10 s, not the more forgiving 30 s a one-off admin action could afford:
      // this call runs inside the worker's single job runner, so a slow or
      // unreachable Cloudflare holds up vpn-key.provision, vpn-key.revoke and
      // node.reconcile for as long as this attempt takes. 10 s is still far
      // inside the job's five-minute lease, and Cloudflare's policy endpoints
      // normally answer in well under a second — see docs/CLOUDFLARE-ACCESS.md.
      const res = await fetch(appScopedUrl, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) {
        // The policy may exist on the account and simply not be attached here.
        // That distinction matters: an unattached policy gates nothing, so
        // maintaining its allowlist would tell an administrator that access is
        // controlled when it is not. Name the real problem instead of leaving
        // them with Cloudflare's bare "policy not found".
        const probe = await fetch(accountScopedUrl, {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        const probeBody = (await probe.json().catch(() => ({}))) as {
          success?: boolean;
        };
        if (probe.ok && probeBody.success !== false) {
          throw new Error(
            `Cloudflare policy ${config.policyId} exists but is not attached to Access application ${config.appId}. ` +
              "An unattached policy protects nothing, so the panel will not manage it — " +
              "attach it to the application, or point cf-config at a policy that is attached.",
          );
        }
      }
      return (await check(res, "get policy")) as CfAccessPolicy;
    },
    async updatePolicy(policy) {
      // Cloudflare requires the full policy document (name + decision) and
      // treats a bare {include} as a replacement — so echo every read field
      // back to avoid a 400 or wiping exclude/require rules.
      await check(
        await fetch(policy.reusable === true ? accountScopedUrl : appScopedUrl, {
          // Both endpoints take PUT and the identical document; PATCH returns
          // 405 ("Method not allowed for this authentication scheme").
          method: "PUT",
          headers,
          body: JSON.stringify({
            name: policy.name,
            decision: policy.decision,
            include: policy.include,
            exclude: policy.exclude ?? [],
            require: policy.require ?? [],
          }),
          // Same 10 s trade-off as getPolicy() above.
          signal: AbortSignal.timeout(10_000),
        }),
        "update policy",
      );
    },
  };
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const apiRequest = async <T>(
  path: string,
  init?: RequestInit,
): Promise<T> => {
  const headers = new Headers(init?.headers);
  // Only declare a JSON body when there is one. A bodyless POST (e.g. the Update
  // button) with `content-type: application/json` makes Fastify reject the empty
  // body (FST_ERR_CTP_EMPTY_JSON_BODY).
  if (init?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`/api/control${path}`, { ...init, headers });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      // A raw Zod validation failure (e.g. a rejected Access domain) has no
      // top-level `message` — only `issues`, one per failed field. The first
      // issue's own message is the readable reason (e.g. "not a domain name"),
      // so it stands in for `message` rather than the caller falling back to a
      // generic "Request failed" that hides why the input was refused.
      issues?: Array<{ message?: string }>;
    };
    throw new ApiClientError(
      response.status,
      error.error ?? "REQUEST_FAILED",
      error.message ??
        error.issues?.[0]?.message ??
        `Request failed with status ${response.status}`,
    );
  }
  if (response.status === 204) return undefined as T;
  // A 202 "queued" may carry no body at all; parsing it would turn a request
  // that succeeded into a thrown error and a false failure toast.
  const text = await response.text();
  return (text === "" ? undefined : JSON.parse(text)) as T;
};

/**
 * `revision` only makes the URL new after a config refresh: an `<img>` with
 * the same src is drawn from the page's image cache whatever the response's
 * cache headers said, so a refreshed QR would otherwise show the old config.
 * The control API ignores the parameter.
 */
export const configUrl = (
  keyId: string,
  format: "vpn" | "conf" | "qr" | "qr-svg" | "qr-frames" | "qr-conf",
  revision?: number,
) =>
  `/api/control/api/keys/${encodeURIComponent(keyId)}/config?format=${format}${
    revision === undefined ? "" : `&rev=${revision}`
  }`;

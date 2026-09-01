/**
 * Header assembly for the admin API calls, kept out of `main.ts` so it can be
 * unit-tested (`main.ts` runs `main()` on import).
 */

/**
 * Build the headers for one request. A JSON content-type is declared ONLY when
 * the request actually carries a body: Fastify rejects a bodyless request that
 * claims `application/json` with FST_ERR_CTP_EMPTY_JSON_BODY, which turned every
 * bodyless call (`node-remove`, and any future DELETE) into an opaque 500 long
 * before the API could answer. Mirrors the same guard in `apps/web/lib/api.ts`.
 *
 * Auth headers come after the content-type and caller headers last, so an
 * explicit `headers` entry always wins.
 */
export const buildRequestHeaders = (
  init: { body?: BodyInit | null; headers?: Record<string, string> } | undefined,
  auth: Record<string, string>,
): Record<string, string> => {
  // An empty string is a body by type but not by content, and Fastify rejects it
  // the same way as a missing one — treat both as "no body".
  const hasBody = init?.body != null && init.body !== "";
  return {
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...auth,
    ...(init?.headers ?? {}),
  };
};

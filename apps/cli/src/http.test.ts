import { describe, expect, it } from "vitest";
import { buildRequestHeaders } from "./http.js";

describe("buildRequestHeaders", () => {
  const auth = { "x-panel-identity": "token" };

  it("omits the JSON content-type on a bodyless request", () => {
    // Declaring application/json without a body made Fastify reject the request
    // with FST_ERR_CTP_EMPTY_JSON_BODY, so `node-remove` always failed with an
    // opaque 500 instead of the API's real answer.
    expect(buildRequestHeaders({ body: null }, auth)).toEqual(auth);
    expect(buildRequestHeaders(undefined, auth)).toEqual(auth);
    expect(buildRequestHeaders({}, auth)).toEqual(auth);
  });

  it("declares the JSON content-type when a body is sent", () => {
    expect(buildRequestHeaders({ body: '{"a":1}' }, auth)).toEqual({
      "content-type": "application/json",
      ...auth,
    });
  });

  it("treats an empty-string body as no body", () => {
    // Fastify rejects `content-type: application/json` with an empty string body
    // exactly as it rejects a missing one, so a `!= null` check alone would leave
    // the same failure reachable.
    expect(buildRequestHeaders({ body: "" }, auth)).toEqual(auth);
  });

  it("lets an explicit caller header win over the defaults", () => {
    expect(
      buildRequestHeaders(
        { body: "{}", headers: { "content-type": "text/plain" } },
        auth,
      ),
    ).toMatchObject({ "content-type": "text/plain" });
  });

  it("keeps the auth headers on every request", () => {
    expect(buildRequestHeaders({ body: "{}" }, auth)).toMatchObject(auth);
    expect(buildRequestHeaders(undefined, auth)).toMatchObject(auth);
  });
});

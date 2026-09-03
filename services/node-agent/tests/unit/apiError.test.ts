import { describe, expect, it } from "vitest";

import { APIError } from "@/utils/APIError";
import { SwaggerContract } from "@/contracts/swagger";
import { ServerErrorCode } from "@/types/shared";

/**
 * APIError re-declared `message` as a class field. Under this tsconfig
 * (target ES2022, useDefineForClassFields defaulting to true) a bare field
 * declaration is EMITTED, and class fields are initialised after super() —
 * so the declaration re-defined the property to undefined right after
 * Error's constructor had set it. Every APIError therefore carried
 * `message: undefined`, and fastifyErrorHandler's `i18n.t(error.message)`
 * translated undefined into every error body the node-agent sends.
 */
describe("APIError", () => {
  it("keeps the i18n key it was constructed with", () => {
    const error = new APIError(ServerErrorCode.SERVICE_UNAVAILABLE, {
      msg: "swagger.errors.DOCKER_NOT_AVAILABLE",
    });

    expect(error.message).toBe("swagger.errors.DOCKER_NOT_AVAILABLE");
  });

  it("falls back to the status code's description when no message is given", () => {
    const error = new APIError(ServerErrorCode.SERVICE_UNAVAILABLE);

    expect(error.message).toBe(
      SwaggerContract.CodeDescriptions[ServerErrorCode.SERVICE_UNAVAILABLE],
    );
  });

  it("still carries the status code and args", () => {
    const error = new APIError(ServerErrorCode.INTERNAL_SERVER_ERROR, {
      msg: "swagger.errors.UNKNOWN",
      args: { name: "awg0.conf" },
    });

    expect(error.statusCode).toBe(ServerErrorCode.INTERNAL_SERVER_ERROR);
    expect(error.args).toEqual({ name: "awg0.conf" });
    expect(error.name).toBe("APIError");
  });

  it("stringifies with its message, so a log line is not just 'APIError'", () => {
    const error = new APIError(ServerErrorCode.SERVICE_UNAVAILABLE, {
      msg: "swagger.errors.DOCKER_NOT_AVAILABLE",
    });

    expect(String(error)).toContain("swagger.errors.DOCKER_NOT_AVAILABLE");
  });
});

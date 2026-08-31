import helmet from "@fastify/helmet";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createKeyRequestSchema,
  createNodeRequestSchema,
  createUserRequestSchema,
  quotaRequestSchema,
  updateCustomRoutesRequestSchema,
  updateNodeRequestSchema,
} from "@amnezia/contracts";
import {
  ApiError,
  type Actor,
  type ConfigFormat,
  type ControlApiService,
  type IdentityClaim,
} from "./service.js";

type Environment = "development" | "test" | "production";

export type IdentityAdapter = (
  request: FastifyRequest,
) => Promise<IdentityClaim | null>;

export type BuildAppOptions = {
  service: ControlApiService;
  environment: Environment;
  identityAdapter?: IdentityAdapter;
  logger?: boolean;
  /**
   * Enable the `x-dev-user-email` header identity path (trusts any caller).
   * Defaults to `environment === "development"`. The real entrypoint gates this
   * behind an explicit opt-in so an accidental NODE_ENV=development in an
   * exposed context cannot become an auth bypass.
   */
  allowDevIdentity?: boolean;
};

const idParamsSchema = z.object({ id: z.uuid() });
const ruleDiffParamsSchema = z.object({ id: z.uuid(), otherId: z.uuid() });
const configQuerySchema = z.object({
  format: z.enum(["vpn", "conf", "qr"]).default("vpn"),
  adminConfirmed: z
    .union([
      z.boolean(),
      z.enum(["true", "false"]).transform((value) => value === "true"),
    ])
    .default(false),
});

const getDevelopmentIdentity = (request: FastifyRequest): IdentityClaim | null => {
  const rawEmail = request.headers["x-dev-user-email"];
  const email = (Array.isArray(rawEmail) ? rawEmail[0] : rawEmail)
    ?.trim()
    .toLowerCase();
  if (!email) return null;
  return { provider: "dev", subject: email, email };
};

export const buildApp = async ({
  service,
  environment,
  identityAdapter,
  logger = false,
  allowDevIdentity,
}: BuildAppOptions) => {
  const app = Fastify({ logger, trustProxy: true });
  const actors = new WeakMap<FastifyRequest, Actor>();
  const devIdentityEnabled = allowDevIdentity ?? environment === "development";

  await app.register(helmet, { contentSecurityPolicy: false });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
      });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        issues: error.issues,
      });
    }
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  });

  app.addHook("onRequest", async (request) => {
    if (request.url === "/healthz") return;
    const claim = devIdentityEnabled
      ? getDevelopmentIdentity(request)
      : await identityAdapter?.(request);
    if (!claim) {
      throw new ApiError(401, "Authentication required", "UNAUTHENTICATED");
    }
    const actor = await service.resolveIdentity(claim);
    if (actor.status !== "active") {
      throw new ApiError(403, "User is disabled", "USER_DISABLED");
    }
    actors.set(request, actor);
  });

  const actorFor = (request: FastifyRequest): Actor => {
    const actor = actors.get(request);
    if (!actor) {
      throw new ApiError(401, "Authentication required", "UNAUTHENTICATED");
    }
    return actor;
  };

  const adminFor = (request: FastifyRequest): Actor => {
    const actor = actorFor(request);
    if (actor.role !== "admin") {
      throw new ApiError(403, "Administrator role required", "FORBIDDEN");
    }
    return actor;
  };

  app.get("/healthz", () => ({ ok: true }));
  app.get("/api/me", async (request) => service.getMe(actorFor(request)));
  app.get("/api/nodes", async (request) => service.listNodes(actorFor(request)));
  app.get("/api/traffic", async (request) => {
    const days = Number((request.query as { days?: string }).days) || 30;
    return service.trafficSeries(actorFor(request), { scope: "self", days });
  });
  app.get("/api/traffic/by-node", async (request) =>
    service.nodeTrafficPeriods(actorFor(request), { scope: "self" }),
  );
  app.get("/api/keys", async (request) => service.listKeys(actorFor(request)));
  app.post("/api/keys", async (request, reply) => {
    const result = await service.requestKey(
      actorFor(request),
      createKeyRequestSchema.parse(request.body),
    );
    return reply.code(202).send(result);
  });
  app.get("/api/keys/:id/config", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const query = configQuerySchema.parse(request.query);
    const result = await service.getKeyConfig(
      actorFor(request),
      id,
      query.format as ConfigFormat,
      query.adminConfirmed,
    );
    reply.header("cache-control", "private, no-store");
    reply.header("pragma", "no-cache");
    reply.header("x-content-type-options", "nosniff");
    reply.type(result.contentType);
    if (result.filename) {
      reply.header(
        "content-disposition",
        `attachment; filename="${result.filename.replaceAll('"', "")}"`,
      );
    }
    return reply.send(result.body);
  });
  app.delete("/api/keys/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    await service.revokeOwnKey(actorFor(request), id);
    return reply.code(204).send();
  });
  app.post("/api/keys/:id/rotate", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    await service.rotateOwnKey(actorFor(request), id);
    return reply.code(202).send({ id, state: "provisioning" });
  });
  app.put("/api/me/custom-routes", async (request) => {
    const routes = await service.updateMyCustomRoutes(
      actorFor(request),
      updateCustomRoutesRequestSchema.parse(request.body),
    );
    return { customRoutes: routes };
  });
  app.get("/api/route-profiles", async (request) =>
    service.listRouteProfiles(actorFor(request)),
  );
  app.get("/api/quota-requests", async (request) =>
    service.listQuotaRequests(actorFor(request)),
  );
  app.post("/api/quota-requests", async (request, reply) => {
    const result = await service.createQuotaRequest(
      actorFor(request),
      quotaRequestSchema.parse(request.body),
    );
    return reply.code(201).send(result);
  });

  app.get("/api/admin/version", (request) => {
    adminFor(request);
    return {
      // Injected at image build time (see scripts/deploy.sh); "dev" locally.
      version: process.env.APP_VERSION ?? "dev",
      commit: process.env.GIT_SHA ?? null,
      builtAt: process.env.BUILD_TIME ?? null,
    };
  });
  app.get("/api/admin/overview", async (request) =>
    service.getAdminOverview(adminFor(request)),
  );
  app.get("/api/admin/traffic", async (request) => {
    const days = Number((request.query as { days?: string }).days) || 30;
    return service.trafficSeries(adminFor(request), { scope: "all", days });
  });
  app.post("/api/admin/users", async (request, reply) => {
    const result = await service.createUser(
      adminFor(request),
      createUserRequestSchema.parse(request.body),
    );
    return reply.code(201).send(result);
  });
  app.post("/api/admin/nodes", async (request, reply) => {
    const result = await service.createNode(
      adminFor(request),
      createNodeRequestSchema.parse(request.body),
    );
    return reply.code(201).send(result);
  });
  app.patch("/api/admin/nodes/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.updateNode(
      adminFor(request),
      id,
      updateNodeRequestSchema.parse(request.body),
    );
  });
  app.delete("/api/admin/nodes/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.deleteNode(adminFor(request), id);
  });
  for (const resource of [
    "users",
    "keys",
    "nodes",
    "quota-requests",
    "rules",
    "audit",
    "portal-policy",
  ]) {
    app.get(`/api/admin/${resource}`, async (request) =>
      service.adminList(adminFor(request), resource),
    );
  }
  app.get("/api/admin/rules/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.getRuleVersion(adminFor(request), id);
  });
  app.get("/api/admin/rules/:id/diff/:otherId", async (request) => {
    const { id, otherId } = ruleDiffParamsSchema.parse(request.params);
    return service.diffRuleVersions(adminFor(request), id, otherId);
  });
  app.post("/api/admin/:resource/:id/:action", async (request) => {
    const params = z
      .object({
        resource: z.string().min(1).max(80),
        id: z.string().min(1).max(200),
        action: z.string().min(1).max(80),
      })
      .parse(request.params);
    return service.adminAction(
      adminFor(request),
      params.resource,
      params.id,
      params.action,
      request.body,
    );
  });

  return app;
};

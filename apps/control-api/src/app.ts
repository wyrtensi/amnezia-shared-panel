import helmet from "@fastify/helmet";
import Fastify, { type FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import {
  MIN_AWG3_CLIENT_VERSION,
  clientPlatformSchema,
  createKeyRequestSchema,
  createNodeRequestSchema,
  createServiceCheckRequestSchema,
  updateServiceCheckRequestSchema,
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
import {
  createUpdateController,
  type UpdateController,
} from "./updateController.js";
import {
  createClientReleaseResolver,
  type ClientReleaseResolver,
} from "./clientReleases.js";

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
  /**
   * Backs the in-panel "Update" button. When omitted, one is built from
   * `UPDATE_SPOOL_DIR` (the feature reports itself disabled if that is unset).
   */
  updateController?: UpdateController;
  /**
   * Resolves the newest AmneziaVPN client release for the in-panel install
   * guide. Injectable for tests; the default talks to GitHub, caches the
   * answer and falls back to version-free links when GitHub is unreachable.
   */
  clientReleaseResolver?: ClientReleaseResolver;
};

const idParamsSchema = z.object({ id: z.uuid() });
const ruleDiffParamsSchema = z.object({ id: z.uuid(), otherId: z.uuid() });
const configQuerySchema = z.object({
  format: z.enum(["vpn", "conf", "qr", "qr-svg", "qr-frames"]).default("vpn"),
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

const versionInfo = () => ({
  // Injected at image build time (see scripts/deploy.sh); "dev" locally.
  version: process.env.APP_VERSION ?? "dev",
  commit: process.env.GIT_SHA ?? null,
  builtAt: process.env.BUILD_TIME ?? null,
});

export const buildApp = async ({
  service,
  environment,
  identityAdapter,
  logger = false,
  allowDevIdentity,
  updateController,
  clientReleaseResolver,
}: BuildAppOptions) => {
  const app = Fastify({ logger, trustProxy: true });
  const actors = new WeakMap<FastifyRequest, Actor>();
  const devIdentityEnabled = allowDevIdentity ?? environment === "development";
  const updates =
    updateController ??
    createUpdateController({
      spoolDir: process.env.UPDATE_SPOOL_DIR,
      version: versionInfo(),
    });
  const clientReleases = clientReleaseResolver ?? createClientReleaseResolver();

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
    if (result.qrParams) {
      // How the symbol was actually drawn. `amnezia-panel key-config` prints
      // these so a "the QR does not scan" report carries the numbers that
      // decide it -- the level and the module count set how many camera pixels
      // land on each module -- instead of an operator inferring them.
      reply.header("x-qr-ecc", result.qrParams.errorCorrectionLevel);
      reply.header("x-qr-modules", String(result.qrParams.modules));
      reply.header("x-qr-scale", String(result.qrParams.scale));
    }
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
  app.get("/api/client-releases", async (request, reply) => {
    // Any signed-in user; the guide is for users, not administrators.
    actorFor(request);
    const release = await clientReleases.get();
    // The resolver already caches hard server-side; this only spares a re-open
    // of the dialog a round trip. Private — the route is behind the identity
    // check, and apps/web forwards cache-control to the browser.
    reply.header("cache-control", "private, max-age=1800");
    return release;
  });
  /**
   * A QR of one platform's download link, for a user reading the guide on a
   * computer who needs the app on a phone.
   *
   * The URL is never taken from the request: the platform and the variant are
   * looked up in the release the panel itself resolved, so this cannot be
   * pointed at an arbitrary target. `?variant=alternate` is the platform's
   * second link -- Android's APK, or the AmneziaVPN listing on iOS. Rendered here rather than in apps/web because the panel
   * already produces QR codes server-side and the web app ships no QR library.
   */
  app.get<{ Params: { platform: string }; Querystring: { variant?: string } }>(
    "/api/client-releases/qr/:platform",
    async (request, reply) => {
      actorFor(request);
      const platform = clientPlatformSchema.safeParse(request.params.platform);
      if (!platform.success) {
        return reply.code(404).send({ error: "UNKNOWN_PLATFORM" });
      }
      // Which of the platform's two links, never the link itself: the URL is
      // read from the release this panel resolved, so a request can ask for one
      // of two known destinations and cannot make the panel encode arbitrary
      // content into an image it serves.
      const variant =
        request.query.variant === "alternate" ? "alternate" : "primary";
      const release = await clientReleases.get();
      const download = release.downloads.find(
        (entry) => entry.platform === platform.data,
      );
      const asset = download?.[variant];
      if (!asset) {
        return reply.code(404).send({ error: "UNKNOWN_PLATFORM" });
      }
      const png = await QRCode.toBuffer(asset.url, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 2,
        width: 512,
      });
      reply.header("cache-control", "private, max-age=1800");
      return reply.type("image/png").send(png);
    },
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
    // The AWG 3.1 client floor rides along with the build info so the CLI can
    // report it without copying the constant: it is a protocol fact that lives
    // once, in @amnezia/contracts, beside the wizard hint and the install guide
    // that interpolate the same value.
    return { ...versionInfo(), minAwg3ClientVersion: MIN_AWG3_CLIENT_VERSION };
  });
  app.get("/api/admin/update", async (request) => {
    adminFor(request);
    return updates.status();
  });
  app.post("/api/admin/update", async (request, reply) => {
    const admin = adminFor(request);
    const result = await updates.request(admin.email);
    return reply.code(202).send(result);
  });
  app.post("/api/admin/client-releases/refresh", async (request) => {
    // A write against shared state — it discards the cached snapshot for every
    // user and may cause an outbound request — so admin only, unlike the read.
    adminFor(request);
    return clientReleases.refresh();
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
  app.post("/api/admin/service-checks", async (request, reply) => {
    const result = await service.createServiceCheck(
      adminFor(request),
      createServiceCheckRequestSchema.parse(request.body),
    );
    return reply.code(201).send(result);
  });
  app.patch("/api/admin/service-checks/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.updateServiceCheck(
      adminFor(request),
      id,
      updateServiceCheckRequestSchema.parse(request.body),
    );
  });
  app.delete("/api/admin/service-checks/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.deleteServiceCheck(adminFor(request), id);
  });
  // A static segment beats `:resource/:id/:action` in Fastify's router, so this
  // can never be parsed as a generic admin action on some resource called
  // "service-checks".
  // Static segments again, so neither can be read as an id.
  app.delete("/api/admin/service-checks/results", async (request) =>
    service.resetServiceCheckResults(adminFor(request), null),
  );
  app.delete("/api/admin/service-checks/:id/results", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.resetServiceCheckResults(adminFor(request), id);
  });
  app.post("/api/admin/service-checks/:id/run", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.runServiceCheckNow(adminFor(request), id);
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
    // Carried in the query, not a body: a DELETE with a JSON body is what makes
    // Fastify reject bodyless requests that still declare a content-type.
    const { deleteKeys } = z
      .object({ deleteKeys: z.enum(["true", "false"]).optional() })
      .parse(request.query ?? {});
    return service.deleteNode(adminFor(request), id, {
      deleteKeys: deleteKeys === "true",
    });
  });
  for (const resource of [
    "users",
    "keys",
    "nodes",
    "quota-requests",
    "rules",
    "audit",
    "portal-policy",
    "global-routes",
    "service-checks",
  ]) {
    app.get(`/api/admin/${resource}`, async (request) =>
      service.adminList(adminFor(request), resource),
    );
  }
  // Declared alongside the parametric rule routes; a static segment always wins
  // over `:id`, so "refresh" can never be parsed as a rule version id.
  app.get("/api/admin/rules/refresh", async (request) =>
    service.getRulesRefreshStatus(adminFor(request)),
  );
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

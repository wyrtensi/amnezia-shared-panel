import { RunChecksType, runChecksSchema } from "@/schemas";
import { runChecksHandler } from "@/handlers/checks";
import { authPreHandler } from "@/middleware/auth";
import { defineController } from "@/helpers/registerControllers";

/**
 * Выполнить проверки доступности сервисов с этой ноды
 */
export const runChecksController = defineController<RunChecksType>({
  url: "/checks/run",
  method: "POST",
  schema: runChecksSchema,
  preHandler: authPreHandler(),
  handler: runChecksHandler,
});

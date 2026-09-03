import {
  GetServerType,
  getServerSchema,
  RebootServerType,
  GetServerLoadType,
  rebootServerSchema,
  GetServerBackupType,
  getServerLoadSchema,
  GetServerUpdateType,
  getServerBackupSchema,
  getServerUpdateSchema,
  ImportServerBackupType,
  importServerBackupSchema,
  RequestServerUpdateType,
  requestServerUpdateSchema,
} from "@/schemas";
import {
  getServerHandler,
  rebootServerHandler,
  getServerLoadHandler,
  getServerBackupHandler,
  getServerUpdateHandler,
  importServerBackupHandler,
  requestServerUpdateHandler,
} from "@/handlers/server";
import { authPreHandler } from "@/middleware/auth";
import { defineController } from "@/helpers/registerControllers";

/**
 * Получить информацию о сервере
 */
export const getServerController = defineController<GetServerType>({
  url: "/server",
  method: "GET",
  schema: getServerSchema,
  preHandler: authPreHandler(),
  handler: getServerHandler,
});

/**
 * Получить метрики нагрузки сервера
 */
export const getServerLoadController = defineController<GetServerLoadType>({
  url: "/server/load",
  method: "GET",
  schema: getServerLoadSchema,
  preHandler: authPreHandler(),
  handler: getServerLoadHandler,
});

/**
 * Резервная копия конфигурации сервера
 */
export const getServerBackupController = defineController<GetServerBackupType>({
  url: "/server/backup",
  method: "GET",
  schema: getServerBackupSchema,
  preHandler: authPreHandler(),
  handler: getServerBackupHandler,
});

/**
 * Импорт резервной копии конфигурации сервера
 */
export const importServerBackupController =
  defineController<ImportServerBackupType>({
    url: "/server/backup",
    method: "POST",
    schema: importServerBackupSchema,
    preHandler: authPreHandler(),
    handler: importServerBackupHandler,
  });

/**
 * Состояние обновления агента
 */
export const getServerUpdateController = defineController<GetServerUpdateType>({
  url: "/server/update",
  method: "GET",
  schema: getServerUpdateSchema,
  preHandler: authPreHandler(),
  handler: getServerUpdateHandler,
});

/**
 * Запросить обновление агента
 */
export const requestServerUpdateController =
  defineController<RequestServerUpdateType>({
    url: "/server/update",
    method: "POST",
    schema: requestServerUpdateSchema,
    preHandler: authPreHandler(),
    handler: requestServerUpdateHandler,
  });

/**
 * Перезагрузить сервер
 */
export const rebootServerController = defineController<RebootServerType>({
  url: "/server/reboot",
  method: "POST",
  schema: rebootServerSchema,
  preHandler: authPreHandler(),
  handler: rebootServerHandler,
});

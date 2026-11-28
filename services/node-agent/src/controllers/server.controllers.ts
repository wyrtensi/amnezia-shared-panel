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
  GetServerCapacityType,
  getServerCapacitySchema,
  RequestServerCapacityType,
  requestServerCapacitySchema,
  SetServerIpv6RejectStubType,
  setServerIpv6RejectStubSchema,
  PutServerEgressType,
  putServerEgressSchema,
  PostServerEgressVerifyType,
  postServerEgressVerifySchema,
  PostServerEgressModeType,
  postServerEgressModeSchema,
} from "@/schemas";
import {
  getServerHandler,
  rebootServerHandler,
  getServerLoadHandler,
  getServerBackupHandler,
  getServerUpdateHandler,
  importServerBackupHandler,
  requestServerUpdateHandler,
  getServerCapacityHandler,
  requestServerCapacityHandler,
  setServerIpv6RejectStubHandler,
  putServerEgressHandler,
  postServerEgressVerifyHandler,
  postServerEgressModeHandler,
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

/**
 * Состояние изменения ёмкости узла
 */
export const getServerCapacityController =
  defineController<GetServerCapacityType>({
    url: "/server/capacity",
    method: "GET",
    schema: getServerCapacitySchema,
    preHandler: authPreHandler(),
    handler: getServerCapacityHandler,
  });

/**
 * Запросить изменение ёмкости узла
 */
export const requestServerCapacityController =
  defineController<RequestServerCapacityType>({
    url: "/server/capacity",
    method: "POST",
    schema: requestServerCapacitySchema,
    preHandler: authPreHandler(),
    handler: requestServerCapacityHandler,
  });

/**
 * Configure the AWG 3.1 IPv6 active-reject stub
 */
export const setServerIpv6RejectStubController =
  defineController<SetServerIpv6RejectStubType>({
    url: "/server/ipv6-reject-stub",
    method: "PUT",
    schema: setServerIpv6RejectStubSchema,
    preHandler: authPreHandler(),
    handler: setServerIpv6RejectStubHandler,
  });

/**
 * Apply desired multi-exit host egress state
 */
export const putServerEgressController = defineController<PutServerEgressType>({
  url: "/server/egress",
  method: "PUT",
  schema: putServerEgressSchema,
  preHandler: authPreHandler(),
  handler: putServerEgressHandler,
});

/**
 * Verify source-bound HTTP egress IP and DNS resolution for an Exit IP
 */
export const postServerEgressVerifyController =
  defineController<PostServerEgressVerifyType>({
    url: "/server/egress/verify",
    method: "POST",
    schema: postServerEgressVerifySchema,
    preHandler: authPreHandler(),
    handler: postServerEgressVerifyHandler,
  });

/**
 * Atomically switch AWG3 egress mode between masquerade and routed
 */
export const postServerEgressModeController =
  defineController<PostServerEgressModeType>({
    url: "/server/egress/mode",
    method: "POST",
    schema: postServerEgressModeSchema,
    preHandler: authPreHandler(),
    handler: postServerEgressModeHandler,
  });

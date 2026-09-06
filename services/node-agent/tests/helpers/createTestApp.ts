import { asValue } from "awilix";
import "@/config/setupMultilingualism";
import { di } from "@/config/DIContainer";
import { createFastify } from "@/config/fastify";
import type { ClientsServiceStub } from "../types";
import { AppFastifyInstance } from "@/types/shared";
import { ClientsService } from "@/services/clients";
import { ServerService } from "@/services/server";

/**
 * Создать тестовое приложение для клиентов
 */
export const createClientsTestApp = async (
  clientsService: ClientsServiceStub,
): Promise<AppFastifyInstance> => {
  di.container.register({
    [ClientsService.key]: asValue(clientsService),
  });

  return createFastify();
};

/**
 * Build a test app whose ServerService is a stub. Route tests need the real
 * Fastify pipeline — auth, validation and serialization — but not the real
 * service, which reads Docker and the host filesystem.
 */
export const createServerTestApp = async (
  serverService: Partial<ServerService>,
): Promise<AppFastifyInstance> => {
  di.container.register({
    [ServerService.key]: asValue(serverService),
  });

  return createFastify();
};

/**
 * Закрыть тестовое приложение
 */
export const closeTestApp = async (app: AppFastifyInstance): Promise<void> => {
  await app.close();
  await di.container.dispose();
};

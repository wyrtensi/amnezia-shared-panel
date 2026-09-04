import { AppFastifySchema } from "@/types/shared";
import { SwaggerContract } from "@/contracts/swagger";

export const getServerCapacitySchema = {
  tags: [SwaggerContract.Tags.SERVER],
  summary: "Состояние изменения ёмкости узла",
  description:
    "Состояние выводится из спула, а не из памяти процесса: применение " +
    "изменения пересоздаёт сам агент, поэтому отвечает уже другой процесс. " +
    "Панель опрашивает этот маршрут, а не держит открытым запрос на изменение.",
  response: {
    200: {
      type: "object",
      description: "Состояние изменения ёмкости",
      required: [
        "available",
        "currentMaxPeers",
        "state",
        "requestedMaxPeers",
        "log",
        "updatedAt",
        "message",
      ],
      properties: {
        available: {
          type: "boolean",
          description:
            "Настроено ли изменение ёмкости на этом сервере (спул + юнит)",
          example: true,
        },
        currentMaxPeers: {
          type: "integer",
          description:
            "SERVER_MAX_PEERS, с которым запущен контейнер прямо сейчас. " +
            "0 означает, что лимит не задан и агент его не проверяет.",
          example: 500,
        },
        state: {
          type: "string",
          enum: ["idle", "requested", "running", "succeeded", "failed"],
          description: "Стадия последнего изменения",
          example: "succeeded",
        },
        requestedMaxPeers: {
          type: "integer",
          nullable: true,
          description: "Значение из последнего запроса или результата",
          example: 300,
        },
        log: {
          type: "string",
          description: "Хвост журнала применения (до 64 КиБ)",
          example: "preflight ok\nrecreated node-agent\n",
        },
        updatedAt: {
          type: "string",
          nullable: true,
          description: "Когда изменение завершилось (ISO)",
          example: SwaggerContract.DateTimeExample,
        },
        message: {
          type: "string",
          nullable: true,
          description: "Итог, записанный скриптом на хосте",
          example: "SERVER_MAX_PEERS=300 applied",
        },
      },
    },
    401: SwaggerContract.ClientErrorResponseFactory(401),
    403: SwaggerContract.ClientErrorResponseFactory(403),
  },
} as const satisfies AppFastifySchema;

export type GetServerCapacityType = typeof getServerCapacitySchema;

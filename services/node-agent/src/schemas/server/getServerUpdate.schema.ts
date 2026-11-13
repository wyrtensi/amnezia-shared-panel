import { AppFastifySchema } from "@/types/shared";
import { SwaggerContract } from "@/contracts/swagger";

export const getServerUpdateSchema = {
  tags: [SwaggerContract.Tags.SERVER],
  summary: "Состояние обновления агента",
  description:
    "Состояние выводится из спула, а не из памяти процесса: обновление заменяет " +
    "сам агент, поэтому отвечает уже другой процесс. Панель опрашивает этот " +
    "маршрут, а не держит открытым запрос на обновление.",
  response: {
    200: {
      type: "object",
      description: "Состояние обновления агента",
      required: ["available", "state", "image", "log", "updatedAt", "message"],
      properties: {
        available: {
          type: "boolean",
          description:
            "Настроено ли обновление на этом сервере (репозиторий + спул)",
          example: true,
        },
        repository: {
          type: "string",
          nullable: true,
          description: "Репозиторий, digest из которого сервер примет",
          example: "ghcr.io/owner/repo/node-agent",
        },
        state: {
          type: "string",
          enum: ["idle", "requested", "running", "succeeded", "failed"],
          description: "Стадия последнего обновления",
          example: "succeeded",
        },
        image: {
          type: "string",
          nullable: true,
          description: "Образ последнего запроса или результата",
          example: `ghcr.io/owner/repo/node-agent@sha256:${"0".repeat(64)}`,
        },
        log: {
          type: "string",
          description: "Хвост журнала обновления (до 64 КиБ)",
          example: "pulled\nrecreated\n",
        },
        updatedAt: {
          type: "string",
          nullable: true,
          description: "Когда обновление завершилось (ISO)",
          example: SwaggerContract.DateTimeExample,
        },
        message: {
          type: "string",
          nullable: true,
          description: "Итог, записанный обновлятором на хосте",
          example: "updated to ghcr.io/owner/repo/node-agent@sha256:...",
        },
        acknowledgement: {
          type: "string",
          nullable: true,
          enum: ["pending", "acknowledged", "unacknowledged", null],
          description:
            "Принял ли хост-обновлятор запрос: в очереди в пределах срока, " +
            "принят (триггер потреблён или есть результат) или не принят " +
            "после срока. Запрос не повторяется автоматически",
          example: "pending",
        },
        requestAgeSeconds: {
          type: "integer",
          nullable: true,
          description: "Возраст неразрешённого запроса, секунды",
          example: 30,
        },
        diagnosticHint: {
          type: "string",
          nullable: true,
          enum: ["UPDATE_NOT_ACKNOWLEDGED", null],
          description:
            "UPDATE_NOT_ACKNOWLEDGED, пока запрос не принят хостом после срока",
          example: null,
        },
      },
    },
    401: SwaggerContract.ClientErrorResponseFactory(401),
    403: SwaggerContract.ClientErrorResponseFactory(403),
  },
} as const satisfies AppFastifySchema;

export type GetServerUpdateType = typeof getServerUpdateSchema;

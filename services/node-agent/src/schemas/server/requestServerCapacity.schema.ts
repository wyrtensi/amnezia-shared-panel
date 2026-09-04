import i18next from "i18next";
import { AppFastifySchema } from "@/types/shared";
import { SwaggerContract } from "@/contracts/swagger";

export const requestServerCapacitySchema = {
  tags: [SwaggerContract.Tags.SERVER],
  summary: "Запросить изменение ёмкости узла",
  description:
    "Записывает запрос в спул; .env правит и контейнер пересоздаёт systemd-юнит " +
    "на хосте, через scripts/set-capacity.sh. Туннели при этом не рвутся: " +
    "пересоздаётся только node-agent. Если изменение ёмкости на сервере не " +
    "настроено, возвращается 501; если предыдущее ещё не завершилось — 409.",
  body: {
    type: "object",
    required: ["maxPeers"],
    additionalProperties: false,
    properties: {
      maxPeers: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description:
          "Новое значение SERVER_MAX_PEERS. Верхняя граница — проверенные 500, " +
          "хотя set-capacity.sh физически принимает до 1000.",
        example: 300,
      },
    },
  },
  response: {
    202: {
      type: "object",
      description: "Запрос принят; результат появится в GET /server/capacity",
      required: ["id", "maxPeers", "message"],
      properties: {
        id: {
          type: "string",
          description: "Идентификатор запроса, он же будет в результате",
          example: SwaggerContract.UUIDExample,
        },
        maxPeers: {
          type: "integer",
          example: 300,
        },
        message: {
          type: "string",
          example: i18next.t("services.server.CAPACITY_REQUESTED"),
        },
      },
    },
    400: SwaggerContract.ClientErrorResponseFactory(400),
    401: SwaggerContract.ClientErrorResponseFactory(401),
    403: SwaggerContract.ClientErrorResponseFactory(403),
    409: SwaggerContract.ClientErrorResponseFactory(409),
    501: SwaggerContract.ServerErrorResponseFactory(501),
  },
} as const satisfies AppFastifySchema;

export type RequestServerCapacityType = typeof requestServerCapacitySchema;

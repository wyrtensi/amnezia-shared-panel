import i18next from "i18next";
import { AppFastifySchema } from "@/types/shared";
import { SwaggerContract } from "@/contracts/swagger";

export const requestServerUpdateSchema = {
  tags: [SwaggerContract.Tags.SERVER],
  summary: "Запросить обновление агента",
  description:
    "Записывает запрос в спул; замену образа выполняет systemd-юнит на хосте. " +
    "Принимается только digest-ссылка в доверенном репозитории (NODE_AGENT_UPDATE_REPO). " +
    "Если обновление на сервере не настроено, возвращается 501.",
  body: {
    type: "object",
    required: ["image"],
    additionalProperties: false,
    properties: {
      image: {
        type: "string",
        minLength: 1,
        maxLength: 512,
        description: "Digest-ссылка вида repository@sha256:<64 hex>",
        example: `ghcr.io/owner/repo/node-agent@sha256:${"0".repeat(64)}`,
      },
    },
  },
  response: {
    202: {
      type: "object",
      description: "Запрос принят; результат появится в GET /server/update",
      required: ["id", "image", "message"],
      properties: {
        id: {
          type: "string",
          description: "Идентификатор запроса, он же будет в результате",
          example: SwaggerContract.UUIDExample,
        },
        image: {
          type: "string",
          example: `ghcr.io/owner/repo/node-agent@sha256:${"0".repeat(64)}`,
        },
        message: {
          type: "string",
          example: i18next.t("services.server.UPDATE_REQUESTED"),
        },
      },
    },
    400: SwaggerContract.ClientErrorResponseFactory(400),
    401: SwaggerContract.ClientErrorResponseFactory(401),
    403: SwaggerContract.ClientErrorResponseFactory(403),
    501: SwaggerContract.ServerErrorResponseFactory(501),
  },
} as const satisfies AppFastifySchema;

export type RequestServerUpdateType = typeof requestServerUpdateSchema;

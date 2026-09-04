import { SwaggerContract } from "@/contracts/swagger";
import { AppFastifySchema } from "@/types/shared";

/**
 * Проверки сервисов приходят от панели и выполняются на ноде.
 *
 * `probe` и `assertions` намеренно описаны как свободные объекты: набор видов
 * проб и типов проверок открытый, и его нельзя зафиксировать в JSON-схеме, не
 * требуя обновления агента ради каждого нового правила. Панель валидирует их
 * своими zod-схемами; агент отвечает `error` на всё, чего не умеет, и
 * публикует свой список в `GET /server` (`checkCapabilities`).
 */
export const runChecksSchema = {
  tags: [SwaggerContract.Tags.CHECKS],
  summary: "Выполнить проверки доступности сервисов с этой ноды",
  description:
    "Ничего не сохраняет: определения приходят в теле запроса, результаты уходят в ответе. " +
    "Проба выполняется из сетевого пространства ноды, то есть с того же публичного адреса, " +
    "с которого выходит VPN-трафик, но НЕ через туннель.",
  body: {
    type: "object",
    required: ["checks"],
    additionalProperties: false,
    properties: {
      checks: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          required: ["id", "probe", "assertions"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              minLength: 1,
              maxLength: 64,
              description: "Идентификатор проверки; он же вернётся в результате",
              example: SwaggerContract.UUIDExample,
            },
            probe: {
              type: "object",
              required: ["kind"],
              properties: {
                kind: { type: "string", example: "http" },
              },
              additionalProperties: true,
            },
            assertions: {
              type: "array",
              minItems: 1,
              maxItems: 10,
              items: {
                type: "object",
                required: ["type"],
                properties: { type: { type: "string", example: "statusIn" } },
                additionalProperties: true,
              },
            },
            timeoutMs: {
              type: "number",
              minimum: 1000,
              maximum: 15000,
              example: 10000,
            },
          },
        },
      },
    },
  },
  response: {
    200: {
      type: "object",
      required: ["results"],
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "status", "latencyMs"],
            properties: {
              id: { type: "string", example: SwaggerContract.UUIDExample },
              status: {
                type: "string",
                enum: ["ok", "failed", "error"],
                description:
                  "ok - проба прошла и все проверки выполнены; failed - проба прошла, проверка не выполнена; " +
                  "error - пробу выполнить не удалось или агент не умеет такую проверку (о сервисе не известно ничего)",
                example: "ok",
              },
              httpStatus: { type: ["number", "null"], example: 200 },
              latencyMs: { type: "number", example: 412 },
              finalUrl: {
                type: ["string", "null"],
                example: "https://example.com/",
              },
              detail: {
                type: ["string", "null"],
                example: 'body does not contain "conversation-container"',
              },
            },
          },
        },
      },
    },
    400: SwaggerContract.ClientErrorResponseFactory(400),
    401: SwaggerContract.ClientErrorResponseFactory(401),
    403: SwaggerContract.ClientErrorResponseFactory(403),
  },
} as const satisfies AppFastifySchema;

export type RunChecksType = typeof runChecksSchema;

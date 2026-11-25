import { SwaggerContract } from "@/contracts/swagger";
import { Protocol, AppFastifySchema } from "@/types/shared";
import { IPV4_PATTERN } from "@/schemas/server/egress.schema";
import { clientIdSchema, protocolSchema } from "./common.schema";

export const createClientSchema = {
  tags: [SwaggerContract.Tags.CLIENTS],
  summary: "Создать нового клиента",
  body: {
    type: "object",
    required: ["clientName"],
    properties: {
      clientName: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        pattern: "^[^\\u0000-\\u001f]+$",
        description: "Имя клиента",
        example: "Kyoresuas",
      },
      protocol: {
        ...protocolSchema,
        default: Protocol.AMNEZIAWG2,
      },
      expiresAt: {
        type: "integer",
        nullable: true,
        description: "Дата окончания доступа",
        example: null,
      },
      egress: {
        type: "object",
        additionalProperties: false,
        required: ["exitIp"],
        description:
          "Optional AWG 3.1 multi-exit routing hint synced to amnezia-egressd",
        properties: {
          exitIp: { type: "string", pattern: IPV4_PATTERN },
          dnsPrimary: { type: "string", pattern: IPV4_PATTERN },
          amneziaDnsDnat: { type: "boolean" },
          enforceDnsDnat: { type: "boolean" },
          routingTableId: { type: "integer", minimum: 200, maximum: 219 },
        },
      },
    },
  },
  response: {
    200: {
      type: "object",
      required: ["message", "client"],
      properties: {
        message: SwaggerContract.ActionResponseSchema.properties.message,
        client: {
          type: "object",
          required: ["id", "config", "protocol"],
          properties: {
            id: clientIdSchema,
            config: {
              type: "string",
              description: "Конфиг для импорта в приложение",
              example: "vpn://3fa85f64-5717-4562-b3fc-2c963f66afa6...",
            },
            protocol: protocolSchema,
          },
        },
      },
    },
    400: SwaggerContract.ClientErrorResponseFactory(400),
    401: SwaggerContract.ClientErrorResponseFactory(401),
    403: SwaggerContract.ClientErrorResponseFactory(403),
    404: SwaggerContract.ClientErrorResponseFactory(404),
    409: SwaggerContract.ClientErrorResponseFactory(409),
  },
} as const satisfies AppFastifySchema;

export type CreateClientType = typeof createClientSchema;

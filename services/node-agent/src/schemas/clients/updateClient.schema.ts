import { PeerStatus } from "@/types/clients";
import { SwaggerContract } from "@/contracts/swagger";
import { Protocol, AppFastifySchema } from "@/types/shared";
import { IPV4_PATTERN } from "@/schemas/server/egress.schema";
import { clientIdSchema, protocolSchema } from "./common.schema";

export const updateClientSchema = {
  tags: [SwaggerContract.Tags.CLIENTS],
  summary: "Обновить данные клиента",
  body: {
    type: "object",
    required: ["clientId"],
    anyOf: [
      {
        required: ["expiresAt"],
      },
      {
        required: ["status"],
      },
      {
        required: ["egress"],
      },
    ],
    properties: {
      clientId: clientIdSchema,
      protocol: {
        ...protocolSchema,
        default: Protocol.AMNEZIAWG,
      },
      expiresAt: {
        type: "integer",
        nullable: true,
        description: "Дата окончания доступа",
        example: 1735689600,
      },
      status: {
        type: "string",
        description: "Статус ключа",
        enum: Object.values(PeerStatus),
        example: PeerStatus.Active,
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
    200: SwaggerContract.ActionResponseSchema,
    400: SwaggerContract.ClientErrorResponseFactory(400),
    401: SwaggerContract.ClientErrorResponseFactory(401),
    403: SwaggerContract.ClientErrorResponseFactory(403),
    404: SwaggerContract.ClientErrorResponseFactory(404),
  },
} as const satisfies AppFastifySchema;

export type UpdateClientType = typeof updateClientSchema;

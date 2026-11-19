import { SwaggerContract } from "@/contracts/swagger";
import { Protocol, AppFastifySchema } from "@/types/shared";

export const getServerSchema = {
  tags: [SwaggerContract.Tags.SERVER],
  summary: "Информация о текущем сервере",
  response: {
    200: {
      type: "object",
      description: "Информация о текущем сервере",
      required: [
        "id",
        "region",
        "weight",
        "maxPeers",
        "totalPeers",
        "protocols",
        "publicHost",
        "agentVersion",
      ],
      properties: {
        id: {
          type: "string",
          description: "Уникальный идентификатор сервера",
          example: SwaggerContract.UUIDExample,
        },
        region: {
          type: "string",
          description: "Регион/зона/лейбл сервера",
          example: "NLs-1",
        },
        weight: {
          type: "number",
          description: "Вес сервера для балансировки",
          example: 100,
        },
        maxPeers: {
          type: "number",
          description: "Максимально допустимое число клиентов",
          example: 200,
        },
        totalPeers: {
          type: "number",
          description: "Текущее число клиентов",
          example: 8,
        },
        protocols: {
          type: "array",
          description: "Список поддерживаемых протоколов",
          items: {
            type: "string",
            enum: Object.values(Protocol),
          },
          example: [Protocol.AMNEZIAWG, Protocol.XRAY],
        },
        publicHost: {
          type: "string",
          description:
            "Публичный хост сервера (SERVER_PUBLIC_HOST), который записывается в клиентские конфигурации",
          example: "vpn.example.com",
        },
        agentVersion: {
          type: "string",
          description: "Версия запущенного агента",
          example: "1.1.14",
        },
        listenPorts: {
          type: "array",
          description:
            "UDP-порты, на которых нода реально слушает, считанные из живых конфигов интерфейсов",
          items: { type: "number" },
          example: [51890],
        },
        checkCapabilities: {
          type: "object",
          description:
            "Что этот агент умеет выполнять в POST /checks/run: виды проб и типы проверок. " +
            "Панель сверяет проверку с этим списком; неизвестный тип возвращается как error, а не ok.",
          required: ["probeKinds", "assertionTypes"],
          properties: {
            probeKinds: {
              type: "array",
              items: { type: "string" },
              example: ["http"],
            },
            assertionTypes: {
              type: "array",
              items: { type: "string" },
              example: ["bodyContains", "statusIn"],
            },
          },
        },
        ipv6RejectStub: {
          type: "object",
          nullable: true,
          description:
            "Observed status of the optional AWG 3.1 IPv6 active-reject stub (ULA + prohibit 2000::/3). Null when amneziawg3 is disabled or unreachable.",
          required: ["supported", "enabled", "active", "prefix", "reason"],
          properties: {
            supported: {
              type: "boolean",
              example: true,
            },
            enabled: {
              type: "boolean",
              example: false,
            },
            active: {
              type: "boolean",
              example: false,
            },
            prefix: {
              type: "string",
              example: "fd6b:7c2e:4a91:9f::/64",
            },
            reason: {
              type: "string",
              nullable: true,
              example: null,
            },
          },
        },
      },
    },
    401: SwaggerContract.ClientErrorResponseFactory(401),
    403: SwaggerContract.ClientErrorResponseFactory(403),
  },
} as const satisfies AppFastifySchema;

export type GetServerType = typeof getServerSchema;

import { AppFastifySchema } from "@/types/shared";
import { SwaggerContract } from "@/contracts/swagger";

export const setServerIpv6RejectStubSchema = {
  tags: [SwaggerContract.Tags.SERVER],
  summary: "Configure the AWG 3.1 IPv6 active-reject stub",
  description:
    "Enables or disables the optional AWG 3.1 ULA + `prohibit 2000::/3` " +
    "route and updates active peer AllowedIPs via `awg syncconf` without " +
    "dropping IPv4 sessions. Returns 409 if the AWG 3.1 container lacks " +
    "the required IPv6 forwarding sysctls.",
  body: {
    type: "object",
    required: ["enabled"],
    additionalProperties: false,
    properties: {
      enabled: {
        type: "boolean",
        description: "Whether the IPv6 active-reject stub should be enabled",
        example: true,
      },
      prefix: {
        type: "string",
        description:
          "Optional canonical RFC 4193 ULA /64 prefix inside fd00::/8",
        example: "fd6b:7c2e:4a91:9f::/64",
      },
    },
  },
  response: {
    200: {
      type: "object",
      description: "Updated live status of the IPv6 active-reject stub",
      required: ["supported", "enabled", "active", "prefix", "reason"],
      properties: {
        supported: { type: "boolean", example: true },
        enabled: { type: "boolean", example: true },
        active: { type: "boolean", example: true },
        prefix: { type: "string", example: "fd6b:7c2e:4a91:9f::/64" },
        reason: { type: "string", nullable: true, example: null },
      },
    },
    400: SwaggerContract.ClientErrorResponseFactory(400),
    401: SwaggerContract.ClientErrorResponseFactory(401),
    403: SwaggerContract.ClientErrorResponseFactory(403),
    409: SwaggerContract.ClientErrorResponseFactory(409),
  },
} as const satisfies AppFastifySchema;

export type SetServerIpv6RejectStubType = typeof setServerIpv6RejectStubSchema;

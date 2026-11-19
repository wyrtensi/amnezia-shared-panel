import { di } from "@/config/DIContainer";
import { SetServerIpv6RejectStubType } from "@/schemas";
import { ServerService } from "@/services/server";
import { AppFastifyHandler } from "@/types/shared";

export const setServerIpv6RejectStubHandler: AppFastifyHandler<
  SetServerIpv6RejectStubType
> = async (req, reply) => {
  const serverService = di.container.resolve<ServerService>(ServerService.key);
  const status = await serverService.setIpv6RejectStub({
    enabled: req.body.enabled,
    prefix: req.body.prefix,
  });

  reply.code(200).send(status);
};

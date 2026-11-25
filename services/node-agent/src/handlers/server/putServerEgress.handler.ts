import { di } from "@/config/DIContainer";
import { PutServerEgressType } from "@/schemas";
import { ServerService } from "@/services/server";
import { AppFastifyHandler } from "@/types/shared";

export const putServerEgressHandler: AppFastifyHandler<
  PutServerEgressType
> = async (req, reply) => {
  const serverService = di.container.resolve<ServerService>(ServerService.key);
  const result = await serverService.applyEgressState(req.body);

  reply.code(200).send(result);
};

import { di } from "@/config/DIContainer";
import { PostServerEgressVerifyType } from "@/schemas";
import { ServerService } from "@/services/server";
import { AppFastifyHandler } from "@/types/shared";

export const postServerEgressVerifyHandler: AppFastifyHandler<
  PostServerEgressVerifyType
> = async (req, reply) => {
  const serverService = di.container.resolve<ServerService>(ServerService.key);
  const result = await serverService.verifyEgressExit(req.body);

  reply.code(200).send(result);
};

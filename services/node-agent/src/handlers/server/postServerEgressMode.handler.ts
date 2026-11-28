import { di } from "@/config/DIContainer";
import { PostServerEgressModeType } from "@/schemas";
import { ServerService } from "@/services/server";
import { AppFastifyHandler } from "@/types/shared";

export const postServerEgressModeHandler: AppFastifyHandler<
  PostServerEgressModeType
> = async (req, reply) => {
  const serverService = di.container.resolve<ServerService>(ServerService.key);
  const result = await serverService.switchEgressMode(req.body.mode);

  reply.code(200).send(result);
};

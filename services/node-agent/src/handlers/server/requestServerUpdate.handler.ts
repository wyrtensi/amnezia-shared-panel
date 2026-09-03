import i18next from "i18next";
import { di } from "@/config/DIContainer";
import { RequestServerUpdateType } from "@/schemas";
import { AgentUpdateService } from "@/services/server";
import { AppFastifyHandler } from "@/types/shared";

export const requestServerUpdateHandler: AppFastifyHandler<
  RequestServerUpdateType
> = async (req, reply) => {
  const agentUpdateService = di.container.resolve<AgentUpdateService>(
    AgentUpdateService.key,
  );
  const { id, image } = await agentUpdateService.requestUpdate(req.body.image);

  // 202, not 200: nothing has been installed yet. The host-side unit does the
  // swap, and the caller learns the outcome from GET /server/update - the agent
  // answering this request is about to be replaced.
  reply.code(202).send({
    id,
    image,
    message: i18next.t("services.server.UPDATE_REQUESTED"),
  });
};

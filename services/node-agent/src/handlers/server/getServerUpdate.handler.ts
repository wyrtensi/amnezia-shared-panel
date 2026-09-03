import { di } from "@/config/DIContainer";
import { GetServerUpdateType } from "@/schemas";
import { AgentUpdateService } from "@/services/server";
import { AppFastifyHandler } from "@/types/shared";

export const getServerUpdateHandler: AppFastifyHandler<
  GetServerUpdateType
> = async (req, reply) => {
  const agentUpdateService = di.container.resolve<AgentUpdateService>(
    AgentUpdateService.key,
  );
  const available = agentUpdateService.isAvailable();
  const status = await agentUpdateService.getStatus();

  // Always 200, including when the feature is off: "this node cannot update
  // itself" is an answer the panel renders, not an error it retries.
  reply.code(200).send({
    available,
    repository: available ? agentUpdateService.getRepository() : null,
    ...status,
  });
};

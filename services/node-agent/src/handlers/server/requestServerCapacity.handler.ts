import i18next from "i18next";
import { di } from "@/config/DIContainer";
import { RequestServerCapacityType } from "@/schemas";
import { CapacityService } from "@/services/server";
import { AppFastifyHandler } from "@/types/shared";

export const requestServerCapacityHandler: AppFastifyHandler<
  RequestServerCapacityType
> = async (req, reply) => {
  const capacityService = di.container.resolve<CapacityService>(
    CapacityService.key,
  );
  const { id, maxPeers } = await capacityService.requestCapacity(
    req.body.maxPeers,
  );

  // 202, not 200: nothing has changed yet. The host-side unit edits .env and
  // recreates the container, and the caller learns the outcome from
  // GET /server/capacity - the agent answering this request is about to be
  // replaced by that recreate.
  reply.code(202).send({
    id,
    maxPeers,
    message: i18next.t("services.server.CAPACITY_REQUESTED"),
  });
};

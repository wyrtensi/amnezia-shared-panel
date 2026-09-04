import { di } from "@/config/DIContainer";
import { GetServerCapacityType } from "@/schemas";
import { CapacityService } from "@/services/server";
import { AppFastifyHandler } from "@/types/shared";

export const getServerCapacityHandler: AppFastifyHandler<
  GetServerCapacityType
> = async (req, reply) => {
  const capacityService = di.container.resolve<CapacityService>(
    CapacityService.key,
  );
  const status = await capacityService.getStatus();

  // Always 200, including when the feature is off: "this node cannot change its
  // own capacity" is an answer the panel renders, not an error it retries.
  reply.code(200).send({
    available: capacityService.isAvailable(),
    currentMaxPeers: capacityService.getCurrentMaxPeers(),
    ...status,
  });
};

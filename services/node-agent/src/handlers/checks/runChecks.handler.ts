import { di } from "@/config/DIContainer";
import { RunChecksType } from "@/schemas";
import { runChecks } from "@/services/checks";
import { EgressService } from "@/services/egress";
import { AppFastifyHandler } from "@/types/shared";

export const runChecksHandler: AppFastifyHandler<RunChecksType> = async (
  req,
  reply,
) => {
  // The agent stores nothing: definitions arrive in the body, results leave in
  // the response. That is what keeps a node replaceable - it holds no state a
  // panel would have to migrate, and a check an admin deletes stops existing
  // everywhere at once.
  const egressService = di.container.hasRegistration(EgressService.key)
    ? di.container.resolve<EgressService>(EgressService.key)
    : undefined;

  const checks = req.body.checks.map((check) => ({
    id: check.id,
    probe: check.probe as Record<string, unknown>,
    assertions: check.assertions as Array<Record<string, unknown>>,
    timeoutMs: check.timeoutMs,
  }));

  const results =
    egressService !== undefined || req.body.egressIpv4 !== undefined
      ? await runChecks(checks, undefined, {
          egressService,
          egressIpv4: req.body.egressIpv4,
        })
      : await runChecks(checks);

  reply.send({ results });
};

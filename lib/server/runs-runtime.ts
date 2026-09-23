import "server-only";

import { requireSameOrigin, requireUserId } from "./auth";
import { getProjectDataPool } from "./db/pool";
import { createRunService } from "./runs";
import { createRunsHandlers } from "./runs-http";
import { createCalculationExecutionRepository } from "./calculation-execution";
import { dispatchOne, recoverCancellation } from "./dispatch";
import { triggerTransport } from "./trigger-transport";

let service: ReturnType<typeof createRunService> | undefined;

export const runsHandlers = createRunsHandlers({
  requireUserId, requireSameOrigin,
  service() {
    if (!service) {
      const pool = getProjectDataPool();
      service = createRunService(pool, process.env.RUN_CURSOR_SECRET ?? "", {
        dispatch: async (runId) => { await dispatchOne(pool, triggerTransport, "calculation", runId); },
        cancelTransaction: (input) => createCalculationExecutionRepository(pool).cancelCalculationRun(input),
        cancelExternal: async (runId) => { await recoverCancellation(pool, triggerTransport, runId); },
      });
    }
    return service;
  },
});

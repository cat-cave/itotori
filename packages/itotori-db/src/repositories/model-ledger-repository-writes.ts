import { permissionValues, requirePermission, type AuthorizationActor } from "../authorization.js";
import type {
  ProviderRunCostSummary,
  ProviderRunLedgerInput,
} from "./model-ledger-repository-types.js";
import {
  assertProviderRunLedgerInput,
  insertProviderRunLedgerRows,
} from "./model-ledger-repository-input.js";
import { ModelLedgerRepositoryBase } from "./model-ledger-repository-base.js";

export class ModelLedgerRepositoryWrites extends ModelLedgerRepositoryBase {
  async recordProviderRun(
    actor: AuthorizationActor,
    input: ProviderRunLedgerInput,
  ): Promise<ProviderRunCostSummary> {
    await requirePermission(this.db, actor, permissionValues.runtimeIngest);
    assertProviderRunLedgerInput(input);
    await this.db.transaction(async (tx) => {
      await insertProviderRunLedgerRows(tx, input);
    });

    const run = await this.getProviderRunCostSummary(input.projectId, input.providerRunId);
    if (!run) {
      throw new Error(`provider run ${input.providerRunId} was not recorded`);
    }
    return run;
  }
}

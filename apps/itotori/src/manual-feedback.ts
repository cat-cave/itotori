import {
  ItotoriFeedbackRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  type ManualFeedbackImportInput,
  type ManualFeedbackImportResult,
} from "@itotori/db";
import { localUserActor } from "./auth.js";

export class ManualFeedbackImportService {
  constructor(
    private readonly repository: Pick<ItotoriFeedbackRepository, "importManualFeedback">,
  ) {}

  async importManualFeedback(
    input: ManualFeedbackImportInput,
  ): Promise<ManualFeedbackImportResult> {
    return this.repository.importManualFeedback(localUserActor, input);
  }
}

export async function importManualFeedbackWithDatabase(
  input: ManualFeedbackImportInput,
): Promise<ManualFeedbackImportResult> {
  const context = createDatabaseContext();
  try {
    await bootstrapLocalUser(context.db);
    const service = new ManualFeedbackImportService(new ItotoriFeedbackRepository(context.db));
    return await service.importManualFeedback(input);
  } finally {
    await context.close();
  }
}

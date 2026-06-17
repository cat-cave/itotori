import {
  ItotoriFeedbackRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  parseManualFeedbackImportInput,
  type ManualFeedbackImportResult,
} from "@itotori/db";
import { localUserActor } from "./auth.js";

export class ManualFeedbackImportService {
  constructor(
    private readonly repository: Pick<ItotoriFeedbackRepository, "importManualFeedback">,
  ) {}

  async importManualFeedback(input: unknown): Promise<ManualFeedbackImportResult> {
    return this.repository.importManualFeedback(
      localUserActor,
      parseManualFeedbackImportInput(input),
    );
  }
}

export async function importManualFeedbackWithDatabase(
  input: unknown,
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

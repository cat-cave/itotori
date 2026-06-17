import {
  type AuthorizationActor,
  type ItotoriFeedbackRepositoryPort,
  type ManualFeedbackImportInput,
  parseManualFeedbackImportInput,
  type ManualFeedbackImportResult,
} from "@itotori/db";
import { localUserActor } from "./auth.js";

export interface ManualFeedbackImportPort {
  importManualFeedback(input: unknown): Promise<ManualFeedbackImportResult>;
}

export class ManualFeedbackImportService {
  constructor(
    private readonly repository: Pick<ItotoriFeedbackRepositoryPort, "importManualFeedback">,
    private readonly actor: AuthorizationActor = localUserActor,
  ) {}

  async importManualFeedback(input: unknown): Promise<ManualFeedbackImportResult> {
    return this.repository.importManualFeedback(this.actor, parseManualFeedbackImportInput(input));
  }
}

export type { ManualFeedbackImportInput };

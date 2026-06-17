export { createDatabaseContext, databaseUrlFromEnv, withDatabase } from "./connection.js";
export type { DatabaseContext, ItotoriDatabase } from "./connection.js";
export {
  AuthorizationError,
  allPermissions,
  bootstrapLocalUser,
  localUserDisplayName,
  localUserId,
  permissionValues,
  requirePermission,
} from "./authorization.js";
export type { AuthorizationActor, Permission } from "./authorization.js";
export { migrate } from "./migrations.js";
export {
  jobIdempotencyPolicyValues,
  jobStatusValues,
  jobTaskTypeValues,
  outboxEventTypeValues,
  outboxStatusValues,
} from "./schema.js";
export type {
  JobIdempotencyPolicy,
  JobStatus,
  JobTaskType,
  OutboxEventType,
  OutboxStatus,
} from "./schema.js";
export {
  defaultWorkspaceId,
  defaultWorkspaceName,
  ItotoriProjectRepository,
} from "./repositories/project-repository.js";
export type {
  ArtifactInput,
  EventInput,
  FindingInput,
  ItotoriProjectRecord,
  ItotoriProjectRepositoryPort,
  LocaleBranchStatus,
  ProjectDashboardStatus,
  RuntimeDashboardStatus,
} from "./repositories/project-repository.js";
export {
  deriveFeedbackDedupeKey,
  feedbackContextStatusValues,
  feedbackReportStatusValues,
  feedbackSourceKindValues,
  feedbackTriageLabelValues,
  feedbackTypeValues,
  ItotoriFeedbackRepository,
  parseManualFeedbackImportInput,
} from "./repositories/feedback-repository.js";
export type {
  FeedbackContextStatus,
  FeedbackReporter,
  FeedbackReportStatus,
  FeedbackSourceKind,
  FeedbackTriageLabel,
  FeedbackType,
  ItotoriFeedbackRepositoryPort,
  ManualFeedbackAttachment,
  ManualFeedbackContextAttachment,
  ManualFeedbackImportInput,
  ManualFeedbackImportResult,
  ManualFeedbackLineReference,
  ManualFeedbackRuntimeArtifactAttachment,
  ManualFeedbackSaveContextAttachment,
  ManualFeedbackScreenshotAttachment,
  ManualFeedbackSourceInput,
} from "./repositories/feedback-repository.js";
export { createUuid7, ItotoriEventQueueRepository } from "./repositories/event-queue-repository.js";
export type {
  ClaimJobsOptions,
  ClaimOutboxEventsOptions,
  ItotoriEventQueueRepositoryPort,
  JobIdempotencyInput,
  JobQueueInput,
  JobQueueRecord,
  OutboxEventInput,
  OutboxEventRecord,
  OutboxEventWithJobsInput,
  OutboxEventWithJobsResult,
  QueueErrorRecord,
  QueueFailureInput,
  QueueJsonRecord,
} from "./repositories/event-queue-repository.js";
export {
  ItotoriJobWorkerService,
  ItotoriOutboxPublisherService,
} from "./services/event-queue-service.js";
export type {
  JobHandler,
  JobHandlerRegistry,
  JobWorkerResult,
  OutboxPublishHandler,
  OutboxPublishResult,
  QueueServiceRunOptions,
} from "./services/event-queue-service.js";

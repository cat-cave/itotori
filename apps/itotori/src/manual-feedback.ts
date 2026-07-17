/** Retired manual-feedback bridge. The new workflow accepts human context
 * through the Wiki object API; this narrow type prevents an old implementation
 * from being reconstructed by an API adapter. */
export type ManualFeedbackImportPort = {
  importManualFeedback(input: unknown): Promise<any>;
};

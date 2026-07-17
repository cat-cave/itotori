/** The legacy WikiBrain/context-correction service was removed. New wiki
 * mutations use the object API composition port. */
export type WikiBrainEditResult = any;
export type WikiBrainServicePort = {
  [operation: string]: (...args: any[]) => Promise<any>;
};
export class WikiBrainEntryNotFoundError extends Error {}
export class WikiBrainEditInputError extends Error {}

import { randomUUID } from "node:crypto";

import { explicitFailurePublicMessage, type ExplicitFailureClassification } from "@itotori/db";
import { classifyApplicationFailure, hasApplicationFailureEvidence } from "./normalize.js";

export interface ApplicationFailureResponse {
  readonly statusCode: number;
  readonly apiCode: ExplicitFailureClassification["apiCode"];
  readonly message: string;
  readonly remainingAllowanceMicrosUsd?: number;
  readonly incidentReference?: string;
  readonly classification: ExplicitFailureClassification;
}

/** Safe response projection shared by API handlers and executable contract probes. */
export function applicationFailureResponse(error: unknown): ApplicationFailureResponse {
  const classification = classifyApplicationFailure(error);
  if (hasApplicationFailureEvidence(error)) {
    return {
      statusCode: classification.httpStatus,
      apiCode: classification.apiCode,
      message: explicitFailurePublicMessage(classification),
      ...(classification.remainingAllowanceMicrosUsd === null
        ? {}
        : { remainingAllowanceMicrosUsd: classification.remainingAllowanceMicrosUsd }),
      classification,
    };
  }
  const incidentReference = `incident:${randomUUID()}`;
  return {
    statusCode: classification.httpStatus,
    apiCode: classification.apiCode,
    message: `${explicitFailurePublicMessage(classification)}; incident reference ${incidentReference}`,
    incidentReference,
    classification,
  };
}

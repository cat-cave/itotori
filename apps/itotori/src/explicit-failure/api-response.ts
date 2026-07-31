import { applicationFailureResponse } from "./response.js";

export interface ExplicitFailureApiBody {
  readonly code: ReturnType<typeof applicationFailureResponse>["apiCode"];
  readonly error: string;
  readonly remainingAllowanceMicrosUsd?: number;
  readonly incidentReference?: string;
}

export interface ExplicitFailureApiResponse {
  readonly statusCode: number;
  readonly body: ExplicitFailureApiBody;
}

/** Dependency-light JSON boundary shared by the live API and contract probes. */
export function explicitFailureApiResponse(error: unknown): ExplicitFailureApiResponse {
  const failure = applicationFailureResponse(error);
  return {
    statusCode: failure.statusCode,
    body: {
      code: failure.apiCode,
      error: failure.message,
      ...(failure.remainingAllowanceMicrosUsd === undefined
        ? {}
        : { remainingAllowanceMicrosUsd: failure.remainingAllowanceMicrosUsd }),
      ...(failure.incidentReference === undefined
        ? {}
        : { incidentReference: failure.incidentReference }),
    },
  };
}

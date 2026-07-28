// config/environment-registry.json is the sole source of truth. The checked-in
// .env.example is generated from it for operators.

import values from "../../../../config/environment-registry.json" with { type: "json" };

export type RegisteredEnvironmentValue = {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly default: string | null;
  readonly whyEnvironmental: string;
};

const registeredValues = values as readonly RegisteredEnvironmentValue[];

export const REGISTERED_PROJECT_ENV: ReadonlyMap<string, RegisteredEnvironmentValue> = new Map(
  registeredValues.map((value) => [value.name, value]),
);

export class ProjectEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectEnvironmentError";
  }
}

/** Read one declared project value without ever echoing its value. */
export function readRegisteredProjectEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const entry = REGISTERED_PROJECT_ENV.get(name);
  if (entry === undefined) {
    throw new ProjectEnvironmentError(
      `undeclared project environment variable ${name}; add it to .env.example or remove the read`,
    );
  }
  const value = env[name];
  if (entry.required && (value === undefined || value.length === 0)) {
    throw new ProjectEnvironmentError(
      `required project environment variable ${name} is absent (${entry.description}); see .env.example`,
    );
  }
  return value;
}

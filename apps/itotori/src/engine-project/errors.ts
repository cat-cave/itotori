export type EngineProjectConfigErrorCode =
  | "invalid-json"
  | "invalid-value"
  | "missing-required-key"
  | "unknown-engine"
  | "unknown-key";

export type EngineProjectConfigErrorOptions = {
  readonly code: EngineProjectConfigErrorCode;
  readonly engine: string | undefined;
  readonly key: string;
  readonly message: string;
};

/** A validation error that identifies the config field and selected engine. */
export class EngineProjectConfigError extends Error {
  readonly code: EngineProjectConfigErrorCode;
  readonly engine: string | undefined;
  readonly key: string;

  constructor(options: EngineProjectConfigErrorOptions) {
    super(options.message);
    this.name = "EngineProjectConfigError";
    this.code = options.code;
    this.engine = options.engine;
    this.key = options.key;
  }
}

export type EngineProjectAdapterManifestErrorCode = "duplicate-engine" | "invalid-manifest";

export type EngineProjectAdapterManifestErrorOptions = {
  readonly code: EngineProjectAdapterManifestErrorCode;
  readonly key: string;
  readonly source: string;
  readonly message: string;
};

/** A validation error for a declarative adapter manifest. */
export class EngineProjectAdapterManifestError extends Error {
  readonly code: EngineProjectAdapterManifestErrorCode;
  readonly key: string;
  readonly source: string;

  constructor(options: EngineProjectAdapterManifestErrorOptions) {
    super(options.message);
    this.name = "EngineProjectAdapterManifestError";
    this.code = options.code;
    this.key = options.key;
    this.source = options.source;
  }
}

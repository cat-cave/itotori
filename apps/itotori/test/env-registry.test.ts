import { describe, expect, it } from "vitest";

import { ProjectEnvironmentError, readRegisteredProjectEnv } from "../src/env/registry.js";

describe("project environment registry", () => {
  it("refuses an undeclared project environment read", () => {
    expect(() => readRegisteredProjectEnv({}, "ITOTORI_UNDECLARED_TEST_VALUE")).toThrow(
      /undeclared project environment variable ITOTORI_UNDECLARED_TEST_VALUE/u,
    );
  });

  it("names the missing required value without printing a secret", () => {
    expect(() => readRegisteredProjectEnv({}, "ITOTORI_FIELD_CIPHER_KEY")).toThrow(
      ProjectEnvironmentError,
    );
    expect(() => readRegisteredProjectEnv({}, "ITOTORI_FIELD_CIPHER_KEY")).toThrow(
      /Envelope master key for durable field data/u,
    );
  });

  it("accepts the one operator-owned corpus mount but not a title path", () => {
    expect(readRegisteredProjectEnv({ ITOTORI_VAULT_ROOT: "/srv/itotori-media" }, "ITOTORI_VAULT_ROOT")).toBe(
      "/srv/itotori-media",
    );
    expect(() => readRegisteredProjectEnv({}, "ITOTORI_REALLIVE_GAME_PATH")).toThrow(
      /undeclared project environment variable ITOTORI_REALLIVE_GAME_PATH/u,
    );
  });
});

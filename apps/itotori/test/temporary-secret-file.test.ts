import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withTemporarySecretFile } from "../src/env/temporary-secret-file.js";

describe("withTemporarySecretFile", () => {
  it("removes a wrapper-owned private secret file after a successful operation", () => {
    const secret = "do-not-report-temporary-secret";
    let createdPath = "";
    const observed = withTemporarySecretFile(
      {
        contents: secret,
        directoryPrefix: "itotori-temporary-secret-test-",
        fileName: "credentials.env",
      },
      (path) => {
        createdPath = path;
        return readFileSync(path, "utf8") === secret;
      },
    );
    expect(observed).toBe(true);
    expect(existsSync(createdPath)).toBe(false);
  });

  it("removes the file when the wrapper operation is interrupted", () => {
    let createdPath = "";
    expect(() =>
      withTemporarySecretFile(
        {
          contents: "do-not-report-interrupted-secret",
          directoryPrefix: "itotori-temporary-secret-test-",
          fileName: "credentials.env",
        },
        (path) => {
          createdPath = path;
          throw new Error("interrupted-launch");
        },
      ),
    ).toThrow("interrupted-launch");
    expect(existsSync(createdPath)).toBe(false);
  });
});

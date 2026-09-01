import { describe, expect, it } from "vite-plus/test";

import {
  formatForgejoConnectionError,
  validateForgejoConnectionDraft,
} from "./ForgejoConnectionsSettings";

describe("Forgejo connection settings", () => {
  it("validates required fields and rejects insecure remote URLs", () => {
    expect(
      validateForgejoConnectionDraft({
        displayName: "",
        baseUrl: "http://git.example.com",
        apiUrl: "not a URL",
        token: "",
      }),
    ).toEqual({
      displayName: "Enter a connection name.",
      baseUrl: "Use HTTPS for remote Forgejo instances.",
      apiUrl: "Enter a valid API URL or leave this field empty.",
      token: "Enter a personal access token.",
    });
  });

  it("never reflects provider internals in user-facing errors", () => {
    expect(
      formatForgejoConnectionError({
        _tag: "SourceControlConnectionAuthenticationError",
        token: "sensitive-fixture-value",
      }),
    ).toBe("Forgejo rejected the token. Check its permissions and try again.");
    expect(formatForgejoConnectionError(new Error("Authorization: token secret"))).not.toContain(
      "secret",
    );
  });
});

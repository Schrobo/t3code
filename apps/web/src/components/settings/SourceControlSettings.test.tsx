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
        sshHost: "git.example.com:2222",
        sshPort: "70000",
        token: "",
      }),
    ).toEqual({
      displayName: "Enter a connection name.",
      baseUrl: "Use HTTPS for remote Forgejo instances.",
      apiUrl: "Enter a valid API URL or leave this field empty.",
      sshHost: "Enter a hostname without a protocol, path, or port.",
      sshPort: "Enter an SSH port from 1 to 65535.",
      token: "Enter a personal access token.",
    });
  });

  it("accepts a nonstandard Forgejo SSH port", () => {
    expect(
      validateForgejoConnectionDraft({
        displayName: "Private Forgejo",
        baseUrl: "https://git.example.com",
        apiUrl: "",
        sshHost: "git.example.com",
        sshPort: "2222",
        token: "opaque-test-token",
      }),
    ).toEqual({});
  });

  it("allows metadata edits without asking for the stored token again", () => {
    expect(
      validateForgejoConnectionDraft(
        {
          displayName: "Private Forgejo",
          baseUrl: "https://git.example.com",
          apiUrl: "https://git.example.com/api/v1",
          sshHost: "git.example.com",
          sshPort: "2222",
          token: "",
        },
        { requireToken: false },
      ),
    ).toEqual({});
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

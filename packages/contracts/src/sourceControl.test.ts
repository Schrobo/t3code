import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  SourceControlConnection,
  SourceControlConnectionAddInput,
  SourceControlConnectionId,
  SourceControlConnectionUrl,
} from "./sourceControl.ts";

const decodeUrl = Schema.decodeUnknownSync(SourceControlConnectionUrl);
const decodeId = Schema.decodeUnknownSync(SourceControlConnectionId);
const decodeAddInput = Schema.decodeUnknownSync(SourceControlConnectionAddInput);
const decodeConnection = Schema.decodeUnknownSync(SourceControlConnection);

describe("SourceControlConnectionUrl", () => {
  it.each([
    ["https://git.example.com/", "https://git.example.com/"],
    ["https://git.example.com/forgejo///", "https://git.example.com/forgejo"],
    ["http://localhost:3000/", "http://localhost:3000/"],
    ["http://tenant.localhost:3000/", "http://tenant.localhost:3000/"],
    ["http://127.42.0.1:3000/", "http://127.42.0.1:3000/"],
    ["http://[::1]:3000/", "http://[::1]:3000/"],
  ])("accepts and normalizes %s", (input, expected) => {
    expect(decodeUrl(input)).toBe(expected);
  });

  it.each([
    "http://git.example.com/",
    "https://user:password@git.example.com/",
    "https://git.example.com/?token=secret",
    "https://git.example.com/#fragment",
    "ftp://git.example.com/",
    "git.example.com",
  ])("rejects unsafe URL %s", (input) => {
    expect(() => decodeUrl(input)).toThrow();
  });
});

describe("SourceControlConnection contracts", () => {
  it("accepts credentials only in mutation input", () => {
    const input = decodeAddInput({
      provider: "forgejo",
      displayName: "Work Forgejo",
      baseUrl: "https://git.example.com/",
      token: "sensitive-fixture-value",
    });

    expect(input.token).toBe("sensitive-fixture-value");
  });

  it("does not transport credentials or credential references in public connections", () => {
    const connection = decodeConnection({
      id: "00000000-0000-4000-8000-000000000001",
      provider: "forgejo",
      displayName: "Work Forgejo",
      baseUrl: "https://git.example.com/",
      apiUrl: "https://git.example.com/api/v1",
      sshHost: "git.example.com",
      sshPort: 22,
      identity: {
        login: "octo",
        displayName: "Octo Cat",
        avatarUrl: "https://cdn.example.com/avatar.png?size=64",
      },
      serverVersion: "12.0.0",
      capabilities: {
        repositorySearch: true,
        repositoryCreate: true,
        changeRequestList: true,
        changeRequestCreate: true,
        changeRequestCheckout: true,
      },
      credentialConfigured: true,
      verifiedAt: DateTime.makeUnsafe("2026-08-31T12:00:00.000Z"),
      token: "sensitive-fixture-value",
      credentialRef: "internal-secret-reference",
    });

    const serialized = JSON.stringify(connection);
    expect(serialized).not.toContain("sensitive-fixture-value");
    expect(serialized).not.toContain("internal-secret-reference");
    expect(connection.identity.avatarUrl).toContain("?size=64");
  });

  it("requires stable UUIDv4 connection IDs", () => {
    expect(decodeId("00000000-0000-4000-8000-000000000001")).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(() => decodeId("forgejo-work")).toThrow();
    expect(() => decodeId("00000000-0000-3000-8000-000000000001")).toThrow();
  });
});

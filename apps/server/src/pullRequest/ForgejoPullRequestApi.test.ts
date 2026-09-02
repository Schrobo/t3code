import { assert, it, vi } from "@effect/vitest";
import {
  SourceControlConnectionId,
  SourceControlConnectionSshHost,
  SourceControlConnectionUrl,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { SourceControlConnectionService } from "../sourceControl/connections/SourceControlConnectionService.ts";
import * as ForgejoHttpClient from "../sourceControl/forgejo/ForgejoHttpClient.ts";
import { ForgejoPullRequestApi, layer } from "./ForgejoPullRequestApi.ts";

const connectionId = SourceControlConnectionId.make("00000000-0000-4000-8000-000000000254");
const connection = {
  id: connectionId,
  provider: "forgejo" as const,
  displayName: "Private Forgejo",
  baseUrl: SourceControlConnectionUrl.make("https://forgejo.test/"),
  apiUrl: SourceControlConnectionUrl.make("https://forgejo.test/api/v1"),
  sshHost: SourceControlConnectionSshHost.make("forgejo.test"),
  sshPort: 2222,
  identity: { login: "forge-user" },
  serverVersion: "15.0.5",
  capabilities: {
    repositorySearch: true,
    repositoryCreate: true,
    changeRequestList: true,
    changeRequestCreate: true,
    changeRequestCheckout: true,
  },
  credentialConfigured: true as const,
  verifiedAt: DateTime.makeUnsafe("2026-09-01T08:00:00.000Z"),
};

function pullRequest(number: number, reviewer: string) {
  return {
    number,
    title: `Pull request ${number}`,
    body: "",
    html_url: `https://forgejo.test/owner/repo/pulls/${number}`,
    state: "open",
    draft: false,
    mergeable: true,
    merged: false,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    comments: 0,
    created_at: "2026-09-01T08:00:00.000Z",
    updated_at: `2026-09-01T08:${String(59 - Math.min(number, 59)).padStart(2, "0")}:00.000Z`,
    closed_at: null,
    merged_at: null,
    user: { login: "author", full_name: null, avatar_url: null },
    requested_reviewers: [{ login: reviewer, full_name: null, avatar_url: null }],
    labels: [],
    base: { ref: "main", sha: "base" },
    head: { ref: `feature-${number}`, sha: `head-${number}` },
  };
}

function pageOf(request: HttpClientRequest.HttpClientRequest): number {
  return Number(request.urlParams.params.find(([key]) => key === "page")?.[1] ?? "1");
}

it.effect("finds a reviewing pull request beyond Forgejo's first 50 results", () => {
  const requestedPages: number[] = [];
  const executeHttp = vi.fn((request: HttpClientRequest.HttpClientRequest) => {
    const page = pageOf(request);
    requestedPages.push(page);
    const rows =
      page === 1
        ? Array.from({ length: 50 }, (_, index) => pullRequest(index + 1, "somebody-else"))
        : page === 2
          ? [pullRequest(51, "forge-user")]
          : [];
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(rows)));
  });
  const resolvedRemoteUrls: string[] = [];
  const connectionLayer = Layer.mock(SourceControlConnectionService)({
    resolveByRemoteUrl: (remoteUrl) => {
      resolvedRemoteUrls.push(remoteUrl);
      return Effect.succeed({ connection, token: "opaque-test-token" });
    },
  });
  const gitLayer = Layer.mock(GitVcsDriver.GitVcsDriver)({
    resolvePrimaryRemoteName: () => Effect.succeed("origin"),
    execute: () =>
      Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: "ssh://git@forgejo.test:2222/owner/repo.git\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
  });
  const httpLayer = ForgejoHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(executeHttp))),
  );
  const testLayer = layer.pipe(
    Layer.provide(connectionLayer),
    Layer.provide(gitLayer),
    Layer.provide(httpLayer),
  );

  return Effect.gen(function* () {
    const api = yield* ForgejoPullRequestApi;
    const result = yield* api.listPullRequests({
      cwd: "/repo",
      repository: "owner/repo",
      state: "open",
      involvement: "reviewing",
      viewer: "forge-user",
      limit: 10,
    });

    assert.deepStrictEqual(requestedPages, [1, 2, 3]);
    const firstRequest = executeHttp.mock.calls[0]?.[0];
    assert.equal(firstRequest?.url, "https://forgejo.test/api/v1/repos/owner/repo/pulls");
    assert.deepStrictEqual(firstRequest?.urlParams.params, [
      ["state", "open"],
      ["sort", "recentupdate"],
      ["limit", "50"],
      ["page", "1"],
    ]);
    assert.deepStrictEqual(resolvedRemoteUrls, ["ssh://git@forgejo.test:2222/owner/repo.git"]);
    assert.deepStrictEqual(
      result.items.map((item) => item.number),
      [51],
    );
    assert.isFalse(result.truncated);
  }).pipe(Effect.provide(testLayer));
});

import * as NodeServices from "@effect/platform-node/NodeServices";
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

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { SourceControlConnectionService } from "../connections/SourceControlConnectionService.ts";
import { ForgejoApi, layer } from "./ForgejoApi.ts";
import * as ForgejoHttpClient from "./ForgejoHttpClient.ts";

const connectionId = SourceControlConnectionId.make("00000000-0000-4000-8000-000000000253");
const connection = {
  id: connectionId,
  provider: "forgejo" as const,
  displayName: "Private Forgejo",
  baseUrl: SourceControlConnectionUrl.make("https://forgejo.test/forge"),
  apiUrl: SourceControlConnectionUrl.make("https://forgejo.test/forge/api/v1"),
  sshHost: SourceControlConnectionSshHost.make("ssh.forgejo.test"),
  sshPort: 2222,
  identity: { login: "schrobo" },
  serverVersion: "16.0.3",
  capabilities: {
    repositorySearch: true,
    repositoryCreate: true,
    changeRequestList: true,
    changeRequestCreate: true,
    changeRequestCheckout: true,
  },
  credentialConfigured: true as const,
  verifiedAt: DateTime.makeUnsafe("2026-08-31T12:00:00.000Z"),
};

const repository = (fullName: string) => {
  const [owner = "owner", name = "repo"] = fullName.split("/");
  return {
    full_name: fullName,
    html_url: `https://forgejo.test/forge/${owner}/${name}`,
    clone_url: `https://forgejo.test/forge/${owner}/${name}.git`,
    ssh_url: `ssh://git@ssh.forgejo.test:2222/${owner}/${name}.git`,
    private: true,
    default_branch: "main",
    owner: { login: owner },
  };
};

const pullRequest = (number: number, head: string, headRepository = "owner/repo") => ({
  number,
  title: `Pull request ${number}`,
  html_url: `https://forgejo.test/forge/owner/repo/pulls/${number}`,
  state: "open",
  merged: false,
  updated_at: "2026-08-31T12:00:00.000Z",
  base: { ref: "main", repo: repository("owner/repo") },
  head: { ref: head, repo: repository(headRepository) },
});

function requestParameter(
  request: HttpClientRequest.HttpClientRequest,
  name: string,
): string | null {
  return request.urlParams.params.find(([key]) => key === name)?.[1] ?? null;
}

function makeLayer(
  handler: (request: HttpClientRequest.HttpClientRequest) => Response,
  gitOverrides: Partial<GitVcsDriver.GitVcsDriver["Service"]> = {},
) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))),
  );
  const connectionService = Layer.mock(SourceControlConnectionService)({
    resolveById: () => Effect.succeed({ connection, token: "opaque-test-token" }),
    resolveByRemoteUrl: () => Effect.succeed({ connection, token: "opaque-test-token" }),
  });
  const httpLayer = ForgejoHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
  );
  const ensureRemote = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"]>(() =>
    Effect.succeed("forgejo-fork"),
  );
  const fetchRemoteBranch = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteBranch"]>(
    () => Effect.void,
  );
  const switchRef = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["switchRef"]>((input) =>
    Effect.succeed({ refName: input.refName }),
  );
  const git = {
    ensureRemote,
    resolvePrimaryRemoteName: vi.fn<
      GitVcsDriver.GitVcsDriver["Service"]["resolvePrimaryRemoteName"]
    >(() => Effect.succeed("origin")),
    listLocalBranchNames: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"]>(() =>
      Effect.succeed([]),
    ),
    fetchRemoteBranch,
    fetchRemoteTrackingBranch: vi.fn<
      GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"]
    >(() => Effect.void),
    setBranchUpstream: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["setBranchUpstream"]>(
      () => Effect.void,
    ),
    switchRef,
    ...gitOverrides,
  };
  return {
    execute,
    git,
    gitSpies: { ensureRemote, fetchRemoteBranch, switchRef },
    layer: layer.pipe(
      Layer.provide(connectionService),
      Layer.provide(httpLayer),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
      Layer.provideMerge(NodeServices.layer),
    ),
  };
}

it.effect("finds a branch pull request after the first 50 Forgejo results", () => {
  const requestedPages: number[] = [];
  const { layer: testLayer } = makeLayer((request) => {
    const page = Number(requestParameter(request, "page"));
    requestedPages.push(page);
    return Response.json(
      page === 1
        ? Array.from({ length: 50 }, (_, index) => pullRequest(index + 1, `other-${index}`))
        : page === 2
          ? [pullRequest(51, "feature/forgejo")]
          : [],
    );
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi;
    const results = yield* forgejo.listPullRequests({
      cwd: "/repo",
      connectionId,
      context: {
        provider: { kind: "forgejo", name: "Forgejo", baseUrl: connection.baseUrl },
        connectionId,
        remoteName: "origin",
        remoteUrl: "ssh://git@ssh.forgejo.test:2222/owner/repo.git",
      },
      headSelector: "feature/forgejo",
      state: "all",
    });

    assert.deepStrictEqual(requestedPages, [1, 2, 3]);
    assert.equal(results.find((item) => item.headRefName === "feature/forgejo")?.number, 51);
  }).pipe(Effect.provide(testLayer));
});

it.effect("checks out a cross-repository Forgejo pull request through GitVcsDriver", () => {
  const { gitSpies, layer: testLayer } = makeLayer(() =>
    Response.json(pullRequest(77, "feature/fork", "fork/repo")),
  );

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi;
    yield* forgejo.checkoutPullRequest({
      cwd: "/repo",
      connectionId,
      context: {
        provider: { kind: "forgejo", name: "Forgejo", baseUrl: connection.baseUrl },
        connectionId,
        remoteName: "origin",
        remoteUrl: "ssh://git@ssh.forgejo.test:2222/owner/repo.git",
      },
      reference: "77",
    });

    assert.deepStrictEqual(gitSpies.ensureRemote.mock.calls[0]?.[0], {
      cwd: "/repo",
      preferredName: "forgejo-fork",
      url: "ssh://git@ssh.forgejo.test:2222/fork/repo.git",
    });
    assert.deepStrictEqual(gitSpies.fetchRemoteBranch.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "forgejo-fork",
      remoteBranch: "feature/fork",
      localBranch: "t3code/pr-77/feature/fork",
    });
    assert.equal(gitSpies.switchRef.mock.calls[0]?.[0].refName, "t3code/pr-77/feature/fork");
  }).pipe(Effect.provide(testLayer));
});

it.effect("searches repositories within the selected Forgejo connection", () => {
  const { execute, layer: testLayer } = makeLayer((request) => {
    const page = Number(requestParameter(request, "page"));
    return Response.json(
      page === 1 ? { ok: true, data: [repository("schrobo/t3code")] } : { ok: true, data: [] },
    );
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi;
    const results = yield* forgejo.searchRepositories({
      cwd: "/repo",
      connectionId,
      query: "t3code",
    });

    assert.equal(results[0]?.connectionId, connectionId);
    assert.equal(results[0]?.nameWithOwner, "schrobo/t3code");
    assert.equal(requestParameter(execute.mock.calls[0]![0], "q"), "t3code");
  }).pipe(Effect.provide(testLayer));
});

it.effect("reads Forgejo clone URLs and the default branch", () => {
  const { layer: testLayer } = makeLayer(() => Response.json(repository("owner/repo")));

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi;
    const context = {
      cwd: "/repo",
      connectionId,
      context: {
        provider: { kind: "forgejo" as const, name: "Forgejo", baseUrl: connection.baseUrl },
        connectionId,
        remoteName: "origin",
        remoteUrl: "https://forgejo.test/forge/owner/repo.git",
      },
    };
    const urls = yield* forgejo.getRepositoryCloneUrls({
      ...context,
      repository: "owner/repo",
    });
    const defaultBranch = yield* forgejo.getDefaultBranch(context);

    assert.deepStrictEqual(urls, {
      nameWithOwner: "owner/repo",
      url: "https://forgejo.test/forge/owner/repo.git",
      sshUrl: "ssh://git@ssh.forgejo.test:2222/owner/repo.git",
    });
    assert.equal(defaultBranch, "main");
  }).pipe(Effect.provide(testLayer));
});

it.effect("uses Forgejo's direct base/head lookup for a one-result branch search", () => {
  const paths: string[] = [];
  const { layer: testLayer } = makeLayer((request) => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    return Response.json(
      path.endsWith("/repos/owner/repo")
        ? repository("owner/repo")
        : pullRequest(12, "feature/direct"),
    );
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi;
    const results = yield* forgejo.listPullRequests({
      cwd: "/repo",
      connectionId,
      context: {
        provider: { kind: "forgejo", name: "Forgejo", baseUrl: connection.baseUrl },
        connectionId,
        remoteName: "origin",
        remoteUrl: "ssh://git@ssh.forgejo.test:2222/owner/repo.git",
      },
      headSelector: "feature/direct",
      state: "open",
      limit: 1,
    });

    assert.equal(results[0]?.number, 12);
    assert.deepStrictEqual(paths, [
      "/forge/api/v1/repos/owner/repo",
      "/forge/api/v1/repos/owner/repo/pulls/main/feature%2Fdirect",
    ]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("falls back from a missing direct lookup and still finds result 51", () => {
  const requestedPages: number[] = [];
  const { layer: testLayer } = makeLayer((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/repos/owner/repo")) return Response.json(repository("owner/repo"));
    if (path.includes("/pulls/main/")) return new Response("not found", { status: 404 });
    const page = Number(requestParameter(request, "page"));
    requestedPages.push(page);
    return Response.json(
      page === 1
        ? Array.from({ length: 50 }, (_, index) => pullRequest(index + 1, `other-${index}`))
        : page === 2
          ? [pullRequest(51, "feature/fallback")]
          : [],
    );
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi;
    const results = yield* forgejo.listPullRequests({
      cwd: "/repo",
      connectionId,
      context: {
        provider: { kind: "forgejo", name: "Forgejo", baseUrl: connection.baseUrl },
        connectionId,
        remoteName: "origin",
        remoteUrl: "https://forgejo.test/forge/owner/repo.git",
      },
      headSelector: "feature/fallback",
      state: "all",
      limit: 1,
    });

    assert.deepStrictEqual(
      results.map((item) => item.number),
      [51],
    );
    assert.deepStrictEqual(requestedPages, [1, 2, 3]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("fully paginates and disambiguates a cross-fork owner selector", () => {
  const requestedPages: number[] = [];
  const { layer: testLayer } = makeLayer((request) => {
    const page = Number(requestParameter(request, "page"));
    requestedPages.push(page);
    return Response.json(
      page <= 2
        ? Array.from({ length: 50 }, (_, index) =>
            pullRequest((page - 1) * 50 + index + 1, "feature/fork", "someone/repo"),
          )
        : page === 3
          ? [pullRequest(101, "feature/fork", "fork/repo")]
          : [],
    );
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi;
    const results = yield* forgejo.listPullRequests({
      cwd: "/repo",
      connectionId,
      context: {
        provider: { kind: "forgejo", name: "Forgejo", baseUrl: connection.baseUrl },
        connectionId,
        remoteName: "origin",
        remoteUrl: "ssh://git@ssh.forgejo.test:2222/owner/repo.git",
      },
      source: { owner: "fork", refName: "feature/fork" },
      headSelector: "fork:feature/fork",
      state: "all",
      limit: 20,
    });

    assert.deepStrictEqual(
      results.map((item) => item.number),
      [101],
    );
    assert.deepStrictEqual(requestedPages, [1, 2, 3, 4]);
  }).pipe(Effect.provide(testLayer));
});

it.effect(
  "creates personal and organization repositories through their distinct Forgejo routes",
  () => {
    const paths: string[] = [];
    const { layer: testLayer } = makeLayer((request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return Response.json(
        path.endsWith("/user/repos") ? repository("schrobo/personal") : repository("ongrow/team"),
        { status: 201 },
      );
    });

    return Effect.gen(function* () {
      const forgejo = yield* ForgejoApi;
      yield* forgejo.createRepository({
        cwd: "/repo",
        connectionId,
        repository: "schrobo/personal",
        visibility: "private",
      });
      yield* forgejo.createRepository({
        cwd: "/repo",
        connectionId,
        repository: "ongrow/team",
        visibility: "public",
      });

      assert.deepStrictEqual(paths, [
        "/forge/api/v1/user/repos",
        "/forge/api/v1/orgs/ongrow/repos",
      ]);
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect("creates a Forgejo pull request through the selected connection", () => {
  const requests: Array<{ readonly method: string; readonly path: string }> = [];
  const { layer: testLayer } = makeLayer((request) => {
    requests.push({ method: request.method, path: new URL(request.url).pathname });
    return Response.json(pullRequest(88, "feature/create"), { status: 201 });
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi;
    yield* forgejo.createPullRequest({
      cwd: "/repo",
      connectionId,
      context: {
        provider: { kind: "forgejo", name: "Forgejo", baseUrl: connection.baseUrl },
        connectionId,
        remoteName: "origin",
        remoteUrl: "https://forgejo.test/forge/owner/repo.git",
      },
      baseBranch: "main",
      headSelector: "feature/create",
      title: "Create through Forgejo",
      bodyFile: import.meta.filename,
    });

    assert.deepStrictEqual(requests, [
      { method: "POST", path: "/forge/api/v1/repos/owner/repo/pulls" },
    ]);
  }).pipe(Effect.provide(testLayer));
});

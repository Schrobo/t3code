import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ForgejoPullRequestApi, ForgejoPullRequestApiError } from "./ForgejoPullRequestApi.ts";
import { make } from "./ForgejoPullRequestProvider.ts";
import { forgejoChecks } from "./forgejoPullRequestJson.ts";

const pullRequest = {
  number: 51,
  title: "Native Forgejo pull requests",
  body: "Read them through the common provider contract.",
  html_url: "https://forgejo.test/owner/repo/pulls/51",
  state: "open",
  draft: false,
  mergeable: true,
  merged: false,
  additions: 12,
  deletions: 3,
  changed_files: 2,
  comments: 1,
  created_at: "2026-09-01T08:00:00.000Z",
  updated_at: "2026-09-01T09:00:00.000Z",
  closed_at: null,
  merged_at: null,
  user: { login: "author", full_name: "Author", avatar_url: null },
  requested_reviewers: [{ login: "forge-user", full_name: null, avatar_url: null }],
  labels: [{ name: "provider", color: "2cbe4e" }],
  base: { ref: "main", sha: "base" },
  head: { ref: "feature/forgejo", sha: "head" },
};

describe("ForgejoPullRequestProvider", () => {
  it("keeps only the newest run of each Forgejo status context", () => {
    expect(
      forgejoChecks([
        {
          context: "CI and Publish / validate (pull_request)",
          status: "failure",
          description: "Old run",
          target_url: null,
          created_at: "2026-09-01T08:00:00.000Z",
          updated_at: "2026-09-01T08:01:00.000Z",
        },
        {
          context: "CI and Publish / validate (pull_request)",
          status: "pending",
          description: "Re-run",
          target_url: null,
          created_at: "2026-09-01T09:00:00.000Z",
          updated_at: "2026-09-01T09:01:00.000Z",
        },
        {
          context: "CI and Publish / publish (pull_request)",
          status: "pending",
          description: null,
          target_url: null,
          created_at: "2026-09-01T09:00:00.000Z",
          updated_at: "2026-09-01T09:01:00.000Z",
        },
      ]),
    ).toEqual([
      {
        name: "CI and Publish / validate (pull_request)",
        status: "pending",
        description: "Re-run",
        url: null,
      },
      {
        name: "CI and Publish / publish (pull_request)",
        status: "pending",
        description: null,
        url: null,
      },
    ]);
  });

  it("restores Forgejo Actions states hidden by the commit-status API", () => {
    const status = (description: string, rawStatus: string = "pending") =>
      forgejoChecks(
        [
          {
            context: `CI / ${description}`,
            status: rawStatus,
            description,
            target_url: "/owner/repo/actions/runs/42/jobs/1",
            created_at: "2026-09-01T09:00:00.000Z",
            updated_at: "2026-09-01T09:01:00.000Z",
          },
        ],
        "https://forgejo.example/",
      )[0];

    expect(status("Has started running")?.status).toBe("pending");
    expect(status("Waiting to run")?.status).toBe("queued");
    expect(status("Blocked by required conditions")?.status).toBe("blocked");
    expect(status("Has been skipped", "success")?.status).toBe("skipped");
    expect(status("Has been cancelled", "failure")?.status).toBe("cancelled");
    expect(status("Waiting to run")?.url).toBe(
      "https://forgejo.example/owner/repo/actions/runs/42/jobs/1",
    );
  });

  it.effect(
    "maps Forgejo rows to the shared provider contract and declares read-only capabilities",
    () => {
      const apiLayer = Layer.mock(ForgejoPullRequestApi)({
        listPullRequests: () => Effect.succeed({ items: [pullRequest], truncated: false }),
      });
      return Effect.gen(function* () {
        const provider = yield* make;
        const page = yield* provider.listChangeRequests({
          cwd: "/repo",
          repository: "owner/repo",
          host: "forgejo.test",
          state: "open",
          involvement: "all",
          viewer: "forge-user",
          limit: 10,
        });

        expect(provider.kind).toBe("forgejo");
        expect(provider.capabilities).toMatchObject({
          diff: true,
          comment: false,
          actions: [],
          reactions: false,
          review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
        });
        expect(page.items[0]).toMatchObject({
          number: 51,
          author: { login: "author", name: "Author" },
          headBranch: "feature/forgejo",
          baseBranch: "main",
          additions: 12,
          deletions: 3,
          reviewRequestLogins: ["forge-user"],
          labels: [{ name: "provider", color: "2cbe4e" }],
        });
      }).pipe(Effect.provide(apiLayer));
    },
  );

  it.effect("turns Forgejo authentication failures into the common provider failure", () => {
    const apiLayer = Layer.mock(ForgejoPullRequestApi)({
      getViewer: () =>
        Effect.fail(
          new ForgejoPullRequestApiError({
            operation: "getViewer",
            detail: "The Forgejo connection was rejected.",
            status: 401,
          }),
        ),
    });
    return Effect.gen(function* () {
      const provider = yield* make;
      const error = yield* provider.getViewer({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error.reason).toBe("unauthenticated");
      expect(error.detail).toBe("The Forgejo connection was rejected.");
    }).pipe(Effect.provide(apiLayer));
  });
});

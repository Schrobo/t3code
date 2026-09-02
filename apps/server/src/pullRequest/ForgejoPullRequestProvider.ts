import * as Effect from "effect/Effect";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as ForgejoPullRequestApi from "./ForgejoPullRequestApi.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import {
  forgejoActor,
  forgejoLabels,
  forgejoMergeability,
  forgejoState,
  type ForgejoNativePullRequest,
} from "./forgejoPullRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: false,
  actions: [],
  mergeMethods: [],
  search: false,
  reactions: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: false, comment: false },
};

const READ_ONLY_PERMISSIONS: PullRequestViewerPermissions = {
  actions: [],
  comment: false,
  resolve: false,
  verdicts: [],
  requestReviewers: false,
};

function toChangeRequest(pullRequest: ForgejoNativePullRequest): ProviderChangeRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.html_url,
    author: forgejoActor(pullRequest.user),
    headBranch: pullRequest.head.ref,
    baseBranch: pullRequest.base.ref,
    state: forgejoState(pullRequest),
    isDraft: pullRequest.draft ?? false,
    mergeability: forgejoMergeability(pullRequest),
    additions: Math.max(0, pullRequest.additions ?? 0),
    deletions: Math.max(0, pullRequest.deletions ?? 0),
    createdAt: pullRequest.created_at,
    updatedAt: pullRequest.updated_at,
    reviewRequestLogins: (pullRequest.requested_reviewers ?? []).map((reviewer) => reviewer.login),
    labels: forgejoLabels(pullRequest),
  };
}

function unsupported(operation: string) {
  return Effect.fail(
    new PullRequestProviderError({
      provider: "forgejo",
      operation,
      reason: "failed",
      detail: "This Forgejo capability is not enabled in this build.",
    }),
  );
}

export const make = Effect.gen(function* () {
  const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

  const fail = (operation: string) => (error: ForgejoPullRequestApi.ForgejoPullRequestApiError) =>
    new PullRequestProviderError({
      provider: "forgejo",
      operation,
      reason:
        error.status === 401 || error.status === 403
          ? "unauthenticated"
          : error.status === 429
            ? "rate-limited"
            : "failed",
      detail: error.detail,
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      cause: error,
    });

  const provider: PullRequestProviderApi = {
    kind: "forgejo",
    capabilities: CAPABILITIES,

    getViewer: (input) => api.getViewer(input).pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      api
        .listPullRequests({
          cwd: input.cwd,
          repository: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit + 1,
          query: input.query,
          cursor: input.cursor,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((page) => ({
            items: page.items.slice(0, input.limit).map(toChangeRequest),
            truncated: page.truncated || page.items.length > input.limit,
            continues: true,
          })),
        ),

    getChangeRequest: (input) =>
      api
        .getPullRequest({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
        })
        .pipe(
          Effect.flatMap((pullRequest) =>
            api
              .listChecks({
                cwd: input.cwd,
                repository: input.repository,
                sha: pullRequest.head.sha,
              })
              .pipe(
                Effect.orElseSucceed(() => []),
                Effect.map((checks) => [pullRequest, checks] as const),
              ),
          ),
          Effect.mapError(fail("getChangeRequest")),
          Effect.map(
            ([pullRequest, checks]): ProviderChangeRequestDetail => ({
              ...toChangeRequest(pullRequest),
              body: pullRequest.body ?? "",
              changedFiles: Math.max(0, pullRequest.changed_files ?? 0),
              mergedAt: pullRequest.merged_at ?? null,
              closedAt: pullRequest.closed_at ?? null,
              reviewers: (pullRequest.requested_reviewers ?? []).flatMap((reviewer) => {
                const actor = forgejoActor(reviewer);
                return actor === null ? [] : [actor];
              }),
              checks,
              mergeCapabilities: { merge: false, squash: false, rebase: false },
              viewerPermissions: READ_ONLY_PERMISSIONS,
            }),
          ),
        ),

    getChangeRequestActivity: (input) =>
      Effect.all(
        [
          api.listComments({ cwd: input.cwd, repository: input.repository, number: input.number }),
          api.listCommits({ cwd: input.cwd, repository: input.repository, number: input.number }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(
          ([comments, commits]): ProviderChangeRequestActivity => ({
            comments,
            commentCount: comments.length,
            commentsTruncated: false,
            reviewThreads: [],
            commits,
          }),
        ),
      ),

    getViewerPermissions: () => Effect.succeed(READ_ONLY_PERMISSIONS),

    getDiff: (input) =>
      api
        .getDiff({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          ...(input.commit === undefined ? {} : { commit: input.commit }),
        })
        .pipe(
          Effect.mapError(fail("getDiff")),
          Effect.map((diff) => ({ ...diff, nextCursor: null })),
        ),

    runAction: () => unsupported("runAction"),
    comment: () => unsupported("comment"),
    submitReview: () => unsupported("submitReview"),
    listReviewerCandidates: () => unsupported("listReviewerCandidates"),
    setReviewerRequest: () => unsupported("setReviewerRequest"),
    replyToThread: () => unsupported("replyToThread"),
    setReaction: () => unsupported("setReaction"),
    setThreadResolution: () => unsupported("setThreadResolution"),
  };

  return provider;
});

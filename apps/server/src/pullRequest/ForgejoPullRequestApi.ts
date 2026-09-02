import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestListState,
} from "@t3tools/contracts";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  SourceControlConnectionService,
  type ResolvedSourceControlConnection,
} from "../sourceControl/connections/SourceControlConnectionService.ts";
import {
  ForgejoHttpClient,
  ForgejoResponseError,
  type ForgejoHttpError,
} from "../sourceControl/forgejo/ForgejoHttpClient.ts";
import {
  ForgejoPaginationError,
  paginateForgejo,
} from "../sourceControl/forgejo/ForgejoPagination.ts";
import type { ProviderListCursor } from "./PullRequestProvider.ts";
import {
  ForgejoCommitListSchema,
  ForgejoCommitStatusListSchema,
  ForgejoIssueCommentListSchema,
  ForgejoNativePullRequestListSchema,
  ForgejoNativePullRequestSchema,
  ForgejoReviewListSchema,
  forgejoChecks,
  forgejoCommit,
  forgejoIssueComment,
  forgejoReview,
  type ForgejoNativePullRequest,
} from "./forgejoPullRequestJson.ts";

const PAGE_SIZE = 50;
const DIFF_MAX_BYTES = 8 * 1024 * 1024;

export class ForgejoPullRequestApiError extends Schema.TaggedErrorClass<ForgejoPullRequestApiError>()(
  "ForgejoPullRequestApiError",
  {
    operation: Schema.String,
    detail: Schema.String,
    status: Schema.optional(Schema.Int),
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Forgejo failed in ${this.operation}: ${this.detail}`;
  }
}

const isForgejoResponseError = Schema.is(ForgejoResponseError);
const isForgejoPullRequestApiError = Schema.is(ForgejoPullRequestApiError);

export interface ForgejoPullRequestBatch {
  readonly items: ReadonlyArray<ForgejoNativePullRequest>;
  readonly truncated: boolean;
}

export class ForgejoPullRequestApi extends Context.Service<
  ForgejoPullRequestApi,
  {
    readonly getViewer: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, ForgejoPullRequestApiError>;
    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<ForgejoPullRequestBatch, ForgejoPullRequestApiError>;
    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ForgejoNativePullRequest, ForgejoPullRequestApiError>;
    readonly listComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestComment>, ForgejoPullRequestApiError>;
    readonly listCommits: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, ForgejoPullRequestApiError>;
    readonly listChecks: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly sha: string;
    }) => Effect.Effect<ReadonlyArray<PullRequestCheck>, ForgejoPullRequestApiError>;
    readonly getDiff: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly commit?: string | undefined;
    }) => Effect.Effect<
      { readonly patch: string; readonly truncated: boolean },
      ForgejoPullRequestApiError
    >;
  }
>()("t3/pullRequest/ForgejoPullRequestApi") {}

function repositoryPath(repository: string): string | null {
  const parts = repository
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/u, "")
    .split("/");
  if (parts.length !== 2 || parts.some((part) => part.trim().length === 0)) return null;
  return `repos/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}`;
}

function nativeStateMatches(pullRequest: ForgejoNativePullRequest, state: PullRequestListState) {
  const merged = pullRequest.merged === true || pullRequest.merged_at != null;
  if (state === "all") return true;
  if (state === "merged") return merged;
  if (state === "open") return !merged && pullRequest.state.toLowerCase() === "open";
  return !merged && pullRequest.state.toLowerCase() !== "open";
}

function involvementMatches(
  pullRequest: ForgejoNativePullRequest,
  involvement: PullRequestInvolvement,
  viewer: string,
) {
  if (involvement === "all") return true;
  const login = viewer.trim().toLowerCase();
  if (involvement === "authored") return pullRequest.user?.login.toLowerCase() === login;
  return (pullRequest.requested_reviewers ?? []).some(
    (reviewer) => reviewer.login.toLowerCase() === login,
  );
}

function apiError(operation: string, detail: string, cause?: unknown) {
  const response = isForgejoResponseError(cause) ? cause : null;
  return new ForgejoPullRequestApiError({
    operation,
    detail,
    ...(response === null ? {} : { status: response.status }),
    ...(response?.retryAt === undefined ? {} : { retryAt: response.retryAt }),
    ...(cause === undefined ? {} : { cause }),
  });
}

export const make = Effect.gen(function* () {
  const connections = yield* SourceControlConnectionService;
  const http = yield* ForgejoHttpClient;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const resolveConnection = (
    cwd: string,
  ): Effect.Effect<ResolvedSourceControlConnection, ForgejoPullRequestApiError> =>
    Effect.gen(function* () {
      const remoteName = yield* git.resolvePrimaryRemoteName(cwd);
      const result = yield* git.execute({
        operation: "ForgejoPullRequestApi.resolveRemoteUrl",
        cwd,
        args: ["remote", "get-url", remoteName],
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      });
      const remoteUrl = result.stdout.trim();
      if (remoteUrl.length === 0) {
        return yield* apiError("resolveConnection", "The project has no Git remote.");
      }
      return yield* connections.resolveByRemoteUrl(remoteUrl);
    }).pipe(
      Effect.mapError((error) =>
        isForgejoPullRequestApiError(error)
          ? error
          : apiError(
              "resolveConnection",
              "No verified Forgejo connection matches this project's remote.",
              error,
            ),
      ),
    );

  const requestConnection = (resolved: ResolvedSourceControlConnection) => ({
    id: resolved.connection.id,
    baseUrl: resolved.connection.baseUrl,
    apiUrl: resolved.connection.apiUrl,
    token: resolved.token,
  });

  const resolveTarget = (cwd: string, repository: string, operation: string) =>
    Effect.gen(function* () {
      const path = repositoryPath(repository);
      if (path === null) {
        return yield* apiError(operation, "A Forgejo repository is addressed as owner/repository.");
      }
      const resolved = yield* resolveConnection(cwd);
      return { path, resolved };
    });

  const paged = <A>(input: {
    readonly resolved: ResolvedSourceControlConnection;
    readonly path: string;
    readonly operation:
      | "listNativePullRequests"
      | "listNativePullRequestComments"
      | "listNativePullRequestReviews"
      | "listNativePullRequestCommits"
      | "listNativeCommitStatuses";
    readonly schema: Schema.Codec<ReadonlyArray<A>, unknown, never>;
  }) =>
    paginateForgejo({
      initialUrl: input.path,
      fetchPage: (pathOrUrl) =>
        http
          .requestJson({
            connection: requestConnection(input.resolved),
            operation: input.operation,
            pathOrUrl,
            schema: input.schema,
          })
          .pipe(
            Effect.map((response) => ({
              items: response.value as ReadonlyArray<A>,
              headers: response.headers,
            })),
          ),
    }).pipe(
      Effect.mapError((error: ForgejoHttpError | ForgejoPaginationError) =>
        apiError(
          input.operation,
          "Forgejo could not return the complete paginated response.",
          error,
        ),
      ),
    );

  return ForgejoPullRequestApi.of({
    getViewer: ({ cwd }) =>
      resolveConnection(cwd).pipe(Effect.map((resolved) => resolved.connection.identity.login)),

    listPullRequests: (input) =>
      resolveTarget(input.cwd, input.repository, "listPullRequests").pipe(
        Effect.flatMap(({ path, resolved }) => {
          const url = new URL(`${resolved.connection.apiUrl.replace(/\/+$/u, "")}/${path}/pulls`);
          url.searchParams.set("state", input.state === "open" ? "open" : "all");
          url.searchParams.set("sort", "recentupdate");
          url.searchParams.set("limit", String(PAGE_SIZE));
          url.searchParams.set("page", "1");
          return paged({
            resolved,
            path: url.toString(),
            operation: "listNativePullRequests",
            schema: ForgejoNativePullRequestListSchema,
          });
        }),
        Effect.map((rows) => {
          const query = input.query?.trim().toLowerCase() ?? "";
          const filtered = rows
            .filter((row) => nativeStateMatches(row, input.state))
            .filter((row) => involvementMatches(row, input.involvement, input.viewer))
            .filter(
              (row) =>
                query.length === 0 ||
                `${row.title}\n${row.body ?? ""}`.toLowerCase().includes(query),
            )
            .filter(
              (row) => input.cursor === undefined || row.updated_at <= input.cursor.updatedBefore,
            )
            .toSorted((left, right) => right.updated_at.localeCompare(left.updated_at));
          return {
            items: filtered.slice(0, input.limit),
            truncated: filtered.length > input.limit,
          };
        }),
      ),

    getPullRequest: (input) =>
      resolveTarget(input.cwd, input.repository, "getPullRequest").pipe(
        Effect.flatMap(({ path, resolved }) =>
          http.requestJson({
            connection: requestConnection(resolved),
            operation: "getNativePullRequest",
            pathOrUrl: `${path}/pulls/${input.number}`,
            schema: ForgejoNativePullRequestSchema,
          }),
        ),
        Effect.map((response) => response.value),
        Effect.mapError((error) =>
          isForgejoPullRequestApiError(error)
            ? error
            : apiError("getPullRequest", "Forgejo could not read this pull request.", error),
        ),
      ),

    listComments: (input) =>
      resolveTarget(input.cwd, input.repository, "listComments").pipe(
        Effect.flatMap(({ path, resolved }) =>
          Effect.all(
            [
              paged({
                resolved,
                path: `${path}/issues/${input.number}/comments?limit=${PAGE_SIZE}`,
                operation: "listNativePullRequestComments",
                schema: ForgejoIssueCommentListSchema,
              }),
              paged({
                resolved,
                path: `${path}/pulls/${input.number}/reviews?limit=${PAGE_SIZE}`,
                operation: "listNativePullRequestReviews",
                schema: ForgejoReviewListSchema,
              }),
            ],
            { concurrency: 2 },
          ),
        ),
        Effect.map(([comments, reviews]) =>
          [...comments.map(forgejoIssueComment), ...reviews.map(forgejoReview)].toSorted(
            (left, right) => left.createdAt.localeCompare(right.createdAt),
          ),
        ),
      ),

    listCommits: (input) =>
      resolveTarget(input.cwd, input.repository, "listCommits").pipe(
        Effect.flatMap(({ path, resolved }) =>
          paged({
            resolved,
            path: `${path}/pulls/${input.number}/commits?limit=${PAGE_SIZE}`,
            operation: "listNativePullRequestCommits",
            schema: ForgejoCommitListSchema,
          }),
        ),
        Effect.map((commits) => commits.map(forgejoCommit)),
      ),

    listChecks: (input) =>
      resolveTarget(input.cwd, input.repository, "listChecks").pipe(
        Effect.flatMap(({ path, resolved }) =>
          paged({
            resolved,
            path: `${path}/commits/${encodeURIComponent(input.sha)}/statuses?limit=${PAGE_SIZE}`,
            operation: "listNativeCommitStatuses",
            schema: ForgejoCommitStatusListSchema,
          }).pipe(Effect.map((statuses) => forgejoChecks(statuses, resolved.connection.baseUrl))),
        ),
      ),

    getDiff: (input) =>
      resolveTarget(input.cwd, input.repository, "getDiff").pipe(
        Effect.flatMap(({ path, resolved }) =>
          http.requestText({
            connection: requestConnection(resolved),
            operation: "getNativePullRequestDiff",
            pathOrUrl:
              input.commit === undefined
                ? `${path}/pulls/${input.number}.diff`
                : `${path}/git/commits/${encodeURIComponent(input.commit)}.diff`,
            maxBytes: DIFF_MAX_BYTES,
          }),
        ),
        Effect.map((response) => ({ patch: response.value, truncated: response.truncated })),
        Effect.mapError((error) =>
          isForgejoPullRequestApiError(error)
            ? error
            : apiError("getDiff", "Forgejo could not read this pull request diff.", error),
        ),
      ),
  });
});

export const layer = Layer.effect(ForgejoPullRequestApi, make);

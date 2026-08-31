import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  SourceControlProviderError,
  type ChangeRequestState,
  type SourceControlConnectionId,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositorySearchItem,
  type SourceControlRepositoryVisibility,
} from "@t3tools/contracts";
import {
  parseRepositoryNameWithOwnerFromRemoteUrl,
  sanitizeBranchFragment,
} from "@t3tools/shared/git";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import {
  SourceControlConnectionService,
  type ResolvedSourceControlConnection,
} from "../connections/SourceControlConnectionService.ts";
import type {
  SourceControlProviderContext,
  SourceControlRefSelector,
} from "../SourceControlProvider.ts";
import { transportSafeSourceControlErrorValue } from "../SourceControlProvider.ts";
import {
  ForgejoHttpClient,
  ForgejoResponseError,
  type ForgejoHttpError,
} from "./ForgejoHttpClient.ts";
import { paginateForgejo } from "./ForgejoPagination.ts";
import {
  ForgejoPullRequestListSchema,
  ForgejoPullRequestSchema,
  ForgejoRepositorySchema,
  ForgejoRepositorySearchSchema,
  normalizeForgejoPullRequest,
  type ForgejoPullRequest,
  type NormalizedForgejoPullRequest,
} from "./ForgejoSchemas.ts";

interface ForgejoRepositoryLocator {
  readonly owner: string;
  readonly repository: string;
}

interface ForgejoContextInput {
  readonly cwd: string;
  readonly context?: SourceControlProviderContext;
  readonly connectionId?: SourceControlConnectionId;
}

function safeError(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly detail: string;
  readonly repository?: string;
  readonly reference?: string;
  readonly cause?: unknown;
}) {
  return new SourceControlProviderError({
    provider: "forgejo",
    operation: input.operation,
    cwd: input.cwd,
    detail: input.detail,
    ...(input.repository === undefined
      ? {}
      : { repository: transportSafeSourceControlErrorValue(input.repository) }),
    ...(input.reference === undefined
      ? {}
      : { reference: transportSafeSourceControlErrorValue(input.reference) }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function parseRepository(value: string): ForgejoRepositoryLocator | null {
  const parts = value
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/u, "")
    .split("/");
  if (parts.length !== 2 || parts.some((part) => part.trim().length === 0)) return null;
  return { owner: parts[0]!, repository: parts[1]! };
}

function repositoryPath(locator: ForgejoRepositoryLocator): string {
  return `repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.repository)}`;
}

function cloneUrls(
  repository: typeof ForgejoRepositorySchema.Type,
): SourceControlRepositoryCloneUrls {
  return {
    nameWithOwner: repository.full_name,
    url: repository.clone_url,
    sshUrl: repository.ssh_url,
  };
}

function repositorySearchItem(
  connectionId: SourceControlConnectionId,
  repository: typeof ForgejoRepositorySchema.Type,
): SourceControlRepositorySearchItem {
  const defaultBranch = repository.default_branch?.trim() ?? "";
  return {
    provider: "forgejo",
    connectionId,
    nameWithOwner: repository.full_name,
    url: repository.clone_url,
    sshUrl: repository.ssh_url,
    visibility: repository.private ? "private" : "public",
    defaultBranch: defaultBranch.length > 0 ? defaultBranch : null,
  };
}

function pullRequestMatchesState(
  pullRequest: NormalizedForgejoPullRequest,
  state: ChangeRequestState | "all",
): boolean {
  return state === "all" || pullRequest.state === state;
}

export class ForgejoApi extends Context.Service<
  ForgejoApi,
  {
    readonly searchRepositories: (
      input: ForgejoContextInput & {
        readonly query: string;
        readonly limit?: number;
      },
    ) => Effect.Effect<
      ReadonlyArray<SourceControlRepositorySearchItem>,
      SourceControlProviderError
    >;
    readonly getRepositoryCloneUrls: (
      input: ForgejoContextInput & {
        readonly repository: string;
      },
    ) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
    readonly createRepository: (
      input: ForgejoContextInput & {
        readonly repository: string;
        readonly visibility: SourceControlRepositoryVisibility;
      },
    ) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
    readonly listPullRequests: (
      input: ForgejoContextInput & {
        readonly source?: SourceControlRefSelector;
        readonly headSelector: string;
        readonly state: ChangeRequestState | "all";
        readonly limit?: number;
      },
    ) => Effect.Effect<ReadonlyArray<NormalizedForgejoPullRequest>, SourceControlProviderError>;
    readonly getPullRequest: (
      input: ForgejoContextInput & {
        readonly reference: string;
      },
    ) => Effect.Effect<NormalizedForgejoPullRequest, SourceControlProviderError>;
    readonly createPullRequest: (
      input: ForgejoContextInput & {
        readonly source?: SourceControlRefSelector;
        readonly target?: SourceControlRefSelector;
        readonly baseBranch: string;
        readonly headSelector: string;
        readonly title: string;
        readonly bodyFile: string;
      },
    ) => Effect.Effect<void, SourceControlProviderError>;
    readonly getDefaultBranch: (
      input: ForgejoContextInput,
    ) => Effect.Effect<string | null, SourceControlProviderError>;
    readonly checkoutPullRequest: (
      input: ForgejoContextInput & {
        readonly reference: string;
        readonly force?: boolean;
      },
    ) => Effect.Effect<void, SourceControlProviderError>;
  }
>()("t3/sourceControl/forgejo/ForgejoApi") {}

export const make = Effect.gen(function* () {
  const connections = yield* SourceControlConnectionService;
  const http = yield* ForgejoHttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const resolveConnection = (input: ForgejoContextInput) => {
    const connectionId = input.connectionId ?? input.context?.connectionId;
    if (connectionId !== undefined) return connections.resolveById(connectionId);
    if (input.context !== undefined) return connections.resolveByRemoteUrl(input.context.remoteUrl);
    return Effect.fail(
      safeError({
        operation: "resolveConnection",
        cwd: input.cwd,
        detail: "Choose a Forgejo connection before continuing.",
      }),
    );
  };

  const resolveRepository = (
    input: ForgejoContextInput & { readonly repository?: string },
  ): Effect.Effect<ForgejoRepositoryLocator, SourceControlProviderError> => {
    const candidate =
      input.repository ??
      (input.context
        ? (parseRepositoryNameWithOwnerFromRemoteUrl(input.context.remoteUrl) ?? undefined)
        : undefined);
    const locator = candidate ? parseRepository(candidate) : null;
    return locator
      ? Effect.succeed(locator)
      : Effect.fail(
          safeError({
            operation: "resolveRepository",
            cwd: input.cwd,
            detail: "Forgejo repositories must be specified as owner/repository.",
            ...(candidate === undefined ? {} : { repository: candidate }),
          }),
        );
  };

  const request = <S extends Schema.Top>(input: {
    readonly resolved: ResolvedSourceControlConnection;
    readonly operation: Parameters<ForgejoHttpClient["Service"]["requestJson"]>[0]["operation"];
    readonly pathOrUrl: string;
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    readonly schema: S;
  }): Effect.Effect<S["Type"], ForgejoHttpError, S["DecodingServices"]> =>
    http
      .requestJson({
        connection: {
          id: input.resolved.connection.id,
          baseUrl: input.resolved.connection.baseUrl,
          apiUrl: input.resolved.connection.apiUrl,
          token: input.resolved.token,
        },
        operation: input.operation,
        pathOrUrl: input.pathOrUrl,
        ...(input.method === undefined ? {} : { method: input.method }),
        ...(input.body === undefined ? {} : { body: input.body }),
        schema: input.schema,
      })
      .pipe(Effect.map((response) => response.value));

  const rawPullRequest = (input: ForgejoContextInput & { readonly reference: string }) =>
    Effect.gen(function* () {
      const resolved = yield* resolveConnection(input);
      const locator = yield* resolveRepository(input);
      const number = Number.parseInt(input.reference.replace(/^#/u, ""), 10);
      if (!Number.isSafeInteger(number) || number < 1) {
        return yield* safeError({
          operation: "getPullRequest",
          cwd: input.cwd,
          reference: input.reference,
          detail: "Enter a valid Forgejo pull request number.",
        });
      }
      return yield* request({
        resolved,
        operation: "getPullRequest",
        pathOrUrl: `${repositoryPath(locator)}/pulls/${number}`,
        schema: ForgejoPullRequestSchema,
      });
    });

  const listRawPullRequests = (
    input: ForgejoContextInput & {
      readonly locator: ForgejoRepositoryLocator;
      readonly state: ChangeRequestState | "all";
      readonly head?: string;
      readonly base?: string;
    },
  ) =>
    Effect.gen(function* () {
      const resolved = yield* resolveConnection(input);
      const url = new URL(
        `${resolved.connection.apiUrl.replace(/\/+$/u, "")}/${repositoryPath(input.locator)}/pulls`,
      );
      url.searchParams.set("state", input.state === "merged" ? "closed" : input.state);
      url.searchParams.set("sort", "recentupdate");
      url.searchParams.set("limit", "50");
      url.searchParams.set("page", "1");
      if (input.head) url.searchParams.set("head", input.head);
      if (input.base) url.searchParams.set("base", input.base);

      return yield* paginateForgejo<ForgejoPullRequest, ForgejoHttpError>({
        initialUrl: url.toString(),
        fetchPage: (pageUrl) =>
          http
            .requestJson({
              connection: {
                id: resolved.connection.id,
                baseUrl: resolved.connection.baseUrl,
                apiUrl: resolved.connection.apiUrl,
                token: resolved.token,
              },
              operation: "listPullRequests",
              pathOrUrl: pageUrl,
              schema: ForgejoPullRequestListSchema,
            })
            .pipe(Effect.map((response) => ({ items: response.value, headers: response.headers }))),
      });
    });

  const getPullRequestByBaseAndHead = (
    input: ForgejoContextInput & {
      readonly locator: ForgejoRepositoryLocator;
      readonly base: string;
      readonly head: string;
    },
  ) =>
    Effect.gen(function* () {
      const resolved = yield* resolveConnection(input);
      return yield* request({
        resolved,
        operation: "findPullRequest",
        pathOrUrl: `${repositoryPath(input.locator)}/pulls/${encodeURIComponent(input.base)}/${encodeURIComponent(input.head)}`,
        schema: ForgejoPullRequestSchema,
      });
    }).pipe(
      Effect.catch((error) =>
        Schema.is(ForgejoResponseError)(error) && error.status === 404
          ? Effect.succeed(null)
          : Effect.fail(error),
      ),
    );

  const mapFailure = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly detail: string;
    readonly repository?: string;
    readonly reference?: string;
  }) =>
    Effect.mapError((cause: unknown) =>
      Schema.is(SourceControlProviderError)(cause) ? cause : safeError({ ...input, cause }),
    );

  return ForgejoApi.of({
    searchRepositories: (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveConnection(input);
        const url = new URL(`${resolved.connection.apiUrl.replace(/\/+$/u, "")}/repos/search`);
        url.searchParams.set("q", input.query.trim());
        url.searchParams.set("limit", "50");
        url.searchParams.set("page", "1");
        const repositories = yield* paginateForgejo({
          initialUrl: url.toString(),
          resultLimit: input.limit ?? 50,
          fetchPage: (pageUrl) =>
            http
              .requestJson({
                connection: {
                  id: resolved.connection.id,
                  baseUrl: resolved.connection.baseUrl,
                  apiUrl: resolved.connection.apiUrl,
                  token: resolved.token,
                },
                operation: "searchRepositories",
                pathOrUrl: pageUrl,
                schema: ForgejoRepositorySearchSchema,
              })
              .pipe(
                Effect.map((response) => ({
                  items: response.value.data,
                  headers: response.headers,
                })),
              ),
        });
        return repositories
          .slice(0, input.limit ?? 50)
          .map((repository) => repositorySearchItem(resolved.connection.id, repository));
      }).pipe(
        mapFailure({
          operation: "searchRepositories",
          cwd: input.cwd,
          detail: "Failed to search Forgejo repositories.",
        }),
      ),
    getRepositoryCloneUrls: (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveConnection(input);
        const locator = yield* resolveRepository(input);
        const repository = yield* request({
          resolved,
          operation: "getRepository",
          pathOrUrl: repositoryPath(locator),
          schema: ForgejoRepositorySchema,
        });
        return cloneUrls(repository);
      }).pipe(
        mapFailure({
          operation: "getRepositoryCloneUrls",
          cwd: input.cwd,
          repository: input.repository,
          detail: "Failed to get Forgejo repository clone URLs.",
        }),
      ),
    createRepository: (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveConnection(input);
        const locator = yield* resolveRepository(input);
        const isUserRepository = locator.owner === resolved.connection.identity.login;
        const path = isUserRepository
          ? "user/repos"
          : `orgs/${encodeURIComponent(locator.owner)}/repos`;
        const repository = yield* request({
          resolved,
          operation: "createRepository",
          pathOrUrl: path,
          method: "POST",
          body: { name: locator.repository, private: input.visibility === "private" },
          schema: ForgejoRepositorySchema,
        });
        return cloneUrls(repository);
      }).pipe(
        mapFailure({
          operation: "createRepository",
          cwd: input.cwd,
          repository: input.repository,
          detail: "Failed to create the Forgejo repository.",
        }),
      ),
    listPullRequests: (input) =>
      Effect.gen(function* () {
        const locator = yield* resolveRepository(input);
        const source = input.source?.refName ?? input.headSelector.replace(/^[^:]+:/u, "");
        if (input.limit === 1) {
          const resolved = yield* resolveConnection(input);
          const repository = yield* request({
            resolved,
            operation: "getRepository",
            pathOrUrl: repositoryPath(locator),
            schema: ForgejoRepositorySchema,
          });
          const base = repository.default_branch?.trim() ?? "";
          if (base.length > 0) {
            const head = input.source?.owner
              ? `${input.source.owner}:${input.source.refName}`
              : source;
            const direct = yield* getPullRequestByBaseAndHead({
              ...input,
              locator,
              base,
              head,
            });
            if (direct !== null) {
              const normalized = normalizeForgejoPullRequest(direct);
              const matchesSource =
                normalized.headRefName === source &&
                (input.source?.owner === undefined ||
                  normalized.headRepositoryOwnerLogin === input.source.owner);
              if (matchesSource) {
                return pullRequestMatchesState(normalized, input.state) ? [normalized] : [];
              }
            }
          }
        }
        const pullRequests = yield* listRawPullRequests({
          ...input,
          locator,
          head: source,
        });
        return pullRequests
          .map(normalizeForgejoPullRequest)
          .filter(
            (pullRequest) =>
              pullRequest.headRefName === source &&
              (input.source?.owner === undefined ||
                pullRequest.headRepositoryOwnerLogin === input.source.owner),
          )
          .filter((pullRequest) => pullRequestMatchesState(pullRequest, input.state))
          .slice(0, input.limit ?? Number.POSITIVE_INFINITY);
      }).pipe(
        mapFailure({
          operation: "listPullRequests",
          cwd: input.cwd,
          reference: input.headSelector,
          detail: "Failed to list Forgejo pull requests.",
        }),
      ),
    getPullRequest: (input) =>
      rawPullRequest(input).pipe(
        Effect.map(normalizeForgejoPullRequest),
        mapFailure({
          operation: "getPullRequest",
          cwd: input.cwd,
          reference: input.reference,
          detail: "Failed to get the Forgejo pull request.",
        }),
      ),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveConnection(input);
        const locator = yield* resolveRepository(input);
        const body = yield* fileSystem.readFileString(input.bodyFile);
        const head = input.source?.owner
          ? `${input.source.owner}:${input.source.refName}`
          : (input.source?.refName ?? input.headSelector);
        yield* request({
          resolved,
          operation: "createPullRequest",
          pathOrUrl: `${repositoryPath(locator)}/pulls`,
          method: "POST",
          body: {
            base: input.target?.refName ?? input.baseBranch,
            head,
            title: input.title,
            body,
          },
          schema: ForgejoPullRequestSchema,
        });
      }).pipe(
        mapFailure({
          operation: "createPullRequest",
          cwd: input.cwd,
          reference: input.headSelector,
          detail: "Failed to create the Forgejo pull request.",
        }),
      ),
    getDefaultBranch: (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveConnection(input);
        const locator = yield* resolveRepository(input);
        const repository = yield* request({
          resolved,
          operation: "getRepository",
          pathOrUrl: repositoryPath(locator),
          schema: ForgejoRepositorySchema,
        });
        const branch = repository.default_branch?.trim() ?? "";
        return branch.length > 0 ? branch : null;
      }).pipe(
        mapFailure({
          operation: "getDefaultBranch",
          cwd: input.cwd,
          detail: "Failed to get the Forgejo default branch.",
        }),
      ),
    checkoutPullRequest: (input) =>
      Effect.gen(function* () {
        const raw = yield* rawPullRequest(input);
        const normalized = normalizeForgejoPullRequest(raw);
        const remoteName =
          input.context?.remoteName ?? (yield* git.resolvePrimaryRemoteName(input.cwd));
        const sourceRepository = raw.head.repo;
        const targetRepository = raw.base.repo;
        const crossRepository =
          sourceRepository !== null &&
          sourceRepository !== undefined &&
          targetRepository !== null &&
          targetRepository !== undefined &&
          sourceRepository.full_name !== targetRepository.full_name;
        const checkoutRemote = crossRepository
          ? yield* git.ensureRemote({
              cwd: input.cwd,
              preferredName: `forgejo-${sourceRepository.owner.login}`,
              url: isSshRemoteUrl(input.context?.remoteUrl ?? "")
                ? sourceRepository.ssh_url
                : sourceRepository.clone_url,
            })
          : remoteName;
        const localBranch = crossRepository
          ? `t3code/pr-${raw.number}/${sanitizeBranchFragment(raw.head.ref)}`
          : raw.head.ref;
        const localBranches = yield* git.listLocalBranchNames(input.cwd);
        if (input.force === true || !localBranches.includes(localBranch)) {
          yield* git.fetchRemoteBranch({
            cwd: input.cwd,
            remoteName: checkoutRemote,
            remoteBranch: raw.head.ref,
            localBranch,
          });
        } else {
          yield* git.fetchRemoteTrackingBranch({
            cwd: input.cwd,
            remoteName: checkoutRemote,
            remoteBranch: normalized.headRefName,
          });
        }
        yield* git.setBranchUpstream({
          cwd: input.cwd,
          branch: localBranch,
          remoteName: checkoutRemote,
          remoteBranch: raw.head.ref,
        });
        yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
      }).pipe(
        mapFailure({
          operation: "checkoutPullRequest",
          cwd: input.cwd,
          reference: input.reference,
          detail: "Failed to check out the Forgejo pull request.",
        }),
      ),
  });
});

export const layer = Layer.effect(ForgejoApi, make);

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { ChangeRequest } from "@t3tools/contracts";

import * as SourceControlProvider from "./SourceControlProvider.ts";
import { ForgejoApi } from "./forgejo/ForgejoApi.ts";
import type { NormalizedForgejoPullRequest } from "./forgejo/ForgejoSchemas.ts";

function toChangeRequest(pullRequest: NormalizedForgejoPullRequest): ChangeRequest {
  return {
    provider: "forgejo",
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    baseRefName: pullRequest.baseRefName,
    headRefName: pullRequest.headRefName,
    state: pullRequest.state,
    updatedAt: pullRequest.updatedAt ?? Option.none(),
    ...(pullRequest.isCrossRepository === undefined
      ? {}
      : { isCrossRepository: pullRequest.isCrossRepository }),
    ...(pullRequest.headRepositoryNameWithOwner === undefined
      ? {}
      : { headRepositoryNameWithOwner: pullRequest.headRepositoryNameWithOwner }),
    ...(pullRequest.headRepositoryOwnerLogin === undefined
      ? {}
      : { headRepositoryOwnerLogin: pullRequest.headRepositoryOwnerLogin }),
  };
}

export const make = Effect.gen(function* () {
  const forgejo = yield* ForgejoApi;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "forgejo",
    searchRepositories: (input) => forgejo.searchRepositories(input),
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return forgejo
        .listPullRequests({
          ...input,
          ...(source === undefined ? {} : { source }),
        })
        .pipe(Effect.map((items) => items.map(toChangeRequest)));
    },
    getChangeRequest: (input) => forgejo.getPullRequest(input).pipe(Effect.map(toChangeRequest)),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return forgejo.createPullRequest({
        ...input,
        baseBranch: input.baseRefName,
        ...(source === undefined ? {} : { source }),
      });
    },
    getRepositoryCloneUrls: (input) => forgejo.getRepositoryCloneUrls(input),
    createRepository: (input) => forgejo.createRepository(input),
    getDefaultBranch: (input) => forgejo.getDefaultBranch(input),
    checkoutChangeRequest: (input) => forgejo.checkoutPullRequest(input),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";

export const ForgejoServerVersionSchema = Schema.Struct({
  version: TrimmedNonEmptyString,
});

export const ForgejoApiSettingsSchema = Schema.Struct({
  default_paging_num: Schema.Int,
  max_response_items: PositiveInt,
});

export const ForgejoUserSchema = Schema.Struct({
  login: TrimmedNonEmptyString,
  full_name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ForgejoRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  html_url: TrimmedNonEmptyString,
  clone_url: TrimmedNonEmptyString,
  ssh_url: TrimmedNonEmptyString,
  private: Schema.Boolean,
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
  owner: ForgejoUserSchema,
});
export type ForgejoRepository = typeof ForgejoRepositorySchema.Type;

export const ForgejoRepositorySearchSchema = Schema.Struct({
  data: Schema.Array(ForgejoRepositorySchema),
  ok: Schema.optional(Schema.Boolean),
});

export const ForgejoPullRequestBranchSchema = Schema.Struct({
  ref: TrimmedNonEmptyString,
  repo: Schema.optional(Schema.NullOr(ForgejoRepositorySchema)),
});

export const ForgejoPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  html_url: TrimmedNonEmptyString,
  state: Schema.String,
  merged: Schema.optional(Schema.Boolean),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  base: ForgejoPullRequestBranchSchema,
  head: ForgejoPullRequestBranchSchema,
});
export type ForgejoPullRequest = typeof ForgejoPullRequestSchema.Type;

export const ForgejoPullRequestListSchema = Schema.Array(ForgejoPullRequestSchema);

export interface NormalizedForgejoPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<Schema.Schema.Type<typeof Schema.DateTimeUtc>>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

function optionalNonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

const decodeDateTime = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString);

function parseDateTime(value: string | null | undefined) {
  if (!value) return Option.none<Schema.Schema.Type<typeof Schema.DateTimeUtc>>();
  return decodeDateTime(value);
}

export function normalizeForgejoPullRequest(
  pullRequest: ForgejoPullRequest,
): NormalizedForgejoPullRequest {
  const headRepositoryNameWithOwner = optionalNonEmpty(pullRequest.head.repo?.full_name);
  const baseRepositoryNameWithOwner = optionalNonEmpty(pullRequest.base.repo?.full_name);
  const headRepositoryOwnerLogin = optionalNonEmpty(pullRequest.head.repo?.owner.login);
  const isCrossRepository =
    headRepositoryNameWithOwner !== null &&
    baseRepositoryNameWithOwner !== null &&
    headRepositoryNameWithOwner !== baseRepositoryNameWithOwner;

  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.html_url,
    baseRefName: pullRequest.base.ref,
    headRefName: pullRequest.head.ref,
    state:
      pullRequest.merged || pullRequest.merged_at
        ? "merged"
        : pullRequest.state === "open"
          ? "open"
          : "closed",
    updatedAt: parseDateTime(pullRequest.updated_at),
    ...(isCrossRepository ? { isCrossRepository: true } : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

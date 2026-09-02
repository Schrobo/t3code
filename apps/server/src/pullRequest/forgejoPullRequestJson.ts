import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestLabel,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import { dedupeChecks } from "./pullRequestChecks.ts";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const ForgejoActorSchema = Schema.Struct({
  login: Schema.String,
  full_name: OptionalString,
  avatar_url: OptionalString,
});

const ForgejoLabelSchema = Schema.Struct({
  name: Schema.String,
  color: OptionalString,
});

const ForgejoBranchSchema = Schema.Struct({
  ref: Schema.String,
  sha: Schema.String,
});

export const ForgejoNativePullRequestSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: OptionalString,
  html_url: Schema.String,
  state: Schema.String,
  draft: Schema.optional(Schema.Boolean),
  mergeable: Schema.optional(Schema.Boolean),
  merged: Schema.optional(Schema.Boolean),
  additions: Schema.optional(Schema.Number),
  deletions: Schema.optional(Schema.Number),
  changed_files: Schema.optional(Schema.Number),
  comments: Schema.optional(Schema.Number),
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: OptionalString,
  merged_at: OptionalString,
  user: Schema.optional(Schema.NullOr(ForgejoActorSchema)),
  requested_reviewers: Schema.optional(Schema.Array(ForgejoActorSchema)),
  labels: Schema.optional(Schema.Array(ForgejoLabelSchema)),
  base: ForgejoBranchSchema,
  head: ForgejoBranchSchema,
});
export type ForgejoNativePullRequest = typeof ForgejoNativePullRequestSchema.Type;
export const ForgejoNativePullRequestListSchema = Schema.Array(ForgejoNativePullRequestSchema);

export const ForgejoIssueCommentSchema = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
  html_url: OptionalString,
  created_at: Schema.String,
  user: Schema.optional(Schema.NullOr(ForgejoActorSchema)),
});
export type ForgejoIssueComment = typeof ForgejoIssueCommentSchema.Type;
export const ForgejoIssueCommentListSchema = Schema.Array(ForgejoIssueCommentSchema);

export const ForgejoReviewSchema = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
  state: Schema.String,
  submitted_at: Schema.String,
  user: Schema.optional(Schema.NullOr(ForgejoActorSchema)),
});
export type ForgejoReview = typeof ForgejoReviewSchema.Type;
export const ForgejoReviewListSchema = Schema.Array(ForgejoReviewSchema);

const ForgejoCommitActorSchema = Schema.Struct({
  login: Schema.optional(Schema.String),
  full_name: OptionalString,
  avatar_url: OptionalString,
});

export const ForgejoCommitSchema = Schema.Struct({
  sha: Schema.String,
  created: OptionalString,
  commit: Schema.Struct({
    message: Schema.String,
    author: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          name: Schema.String,
          date: Schema.String,
        }),
      ),
    ),
  }),
  author: Schema.optional(Schema.NullOr(ForgejoCommitActorSchema)),
});
export type ForgejoCommit = typeof ForgejoCommitSchema.Type;
export const ForgejoCommitListSchema = Schema.Array(ForgejoCommitSchema);

export const ForgejoCommitStatusSchema = Schema.Struct({
  context: Schema.String,
  status: Schema.String,
  description: OptionalString,
  target_url: OptionalString,
  created_at: OptionalString,
  updated_at: OptionalString,
});
export type ForgejoCommitStatus = typeof ForgejoCommitStatusSchema.Type;
export const ForgejoCommitStatusListSchema = Schema.Array(ForgejoCommitStatusSchema);

function trimmed(value: string | null | undefined): string | null {
  const result = value?.trim() ?? "";
  return result.length > 0 ? result : null;
}

export function forgejoActor(
  raw: typeof ForgejoActorSchema.Type | typeof ForgejoCommitActorSchema.Type | null | undefined,
): PullRequestActor | null {
  const login = trimmed(raw?.login);
  if (login === null) return null;
  return {
    login,
    name: trimmed(raw?.full_name),
    avatarUrl: trimmed(raw?.avatar_url),
  };
}

export function forgejoState(raw: ForgejoNativePullRequest): PullRequestState {
  if (raw.merged === true || trimmed(raw.merged_at) !== null) return "merged";
  return raw.state.toLowerCase() === "open" ? "open" : "closed";
}

export function forgejoMergeability(raw: ForgejoNativePullRequest): PullRequestMergeability {
  if (raw.mergeable === true) return "mergeable";
  if (raw.mergeable === false) return "conflicting";
  return "unknown";
}

export function forgejoLabels(raw: ForgejoNativePullRequest): ReadonlyArray<PullRequestLabel> {
  return (raw.labels ?? []).flatMap((label) => {
    const name = trimmed(label.name);
    return name === null ? [] : [{ name, color: trimmed(label.color) }];
  });
}

export function forgejoIssueComment(raw: ForgejoIssueComment): PullRequestComment {
  return {
    id: String(raw.id),
    kind: "issue-comment",
    author: forgejoActor(raw.user),
    body: raw.body,
    createdAt: raw.created_at,
    url: trimmed(raw.html_url),
    path: null,
    reviewState: null,
  };
}

export function forgejoReview(raw: ForgejoReview): PullRequestComment {
  return {
    id: `review:${raw.id}`,
    kind: "review",
    author: forgejoActor(raw.user),
    body: raw.body,
    createdAt: raw.submitted_at,
    url: null,
    path: null,
    reviewState: trimmed(raw.state),
  };
}

export function forgejoCommit(raw: ForgejoCommit): PullRequestCommit {
  const author = forgejoActor(raw.author);
  return {
    oid: raw.sha,
    messageHeadline: raw.commit.message.split("\n")[0] ?? "",
    committedDate: trimmed(raw.created) ?? raw.commit.author?.date ?? "1970-01-01T00:00:00.000Z",
    ...(author === null ? {} : { authors: [author] }),
  };
}

function forgejoCheckUrl(value: string | null | undefined, baseUrl?: string): string | null {
  const target = trimmed(value);
  if (target === null) return null;
  if (baseUrl === undefined) return target;
  try {
    return new URL(target, baseUrl).toString();
  } catch {
    return null;
  }
}

export function forgejoCheck(raw: ForgejoCommitStatus, baseUrl?: string): PullRequestCheck | null {
  const name = trimmed(raw.context);
  if (name === null) return null;
  const state = raw.status.toLowerCase();
  const description = trimmed(raw.description);
  // Forgejo Actions deliberately folds several job states into the four-state commit-status API.
  // Its stable descriptions carry the lost distinction (services/actions/commit_status.go): a
  // skipped job is reported as success, while waiting, blocked and running all arrive as pending.
  const status: PullRequestCheck["status"] =
    description === "Has been skipped"
      ? "skipped"
      : description === "Has been cancelled"
        ? "cancelled"
        : description === "Blocked by required conditions"
          ? "blocked"
          : description === "Waiting to run"
            ? "queued"
            : state === "success"
              ? "success"
              : state === "failure" || state === "error"
                ? "failure"
                : state === "warning"
                  ? "neutral"
                  : "pending";
  return {
    name,
    status,
    description,
    url: forgejoCheckUrl(raw.target_url, baseUrl),
  };
}

export function forgejoChecks(
  statuses: ReadonlyArray<ForgejoCommitStatus>,
  baseUrl?: string,
): ReadonlyArray<PullRequestCheck> {
  return dedupeChecks(
    statuses.flatMap((status) => {
      const check = forgejoCheck(status, baseUrl);
      return check === null
        ? []
        : [
            {
              check,
              workflowName: null,
              at: trimmed(status.updated_at) ?? trimmed(status.created_at),
            },
          ];
    }),
  );
}

import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { VcsDriverKind } from "./vcs.ts";

const SOURCE_CONTROL_CONNECTION_URL_MAX_LENGTH = 2_048;
const SOURCE_CONTROL_CONNECTION_TOKEN_MAX_LENGTH = 8_192;

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "[::1]" || hostname === "::1") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

function isSafeSourceControlConnectionUrl(value: string): boolean | string {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return "URL credentials are not allowed.";
    if (url.search !== "") return "URL query parameters are not allowed.";
    if (url.hash !== "") return "URL fragments are not allowed.";
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return true;
    return "URLs must use HTTPS. HTTP is allowed only for loopback hosts.";
  } catch {
    return "Expected an absolute source-control URL.";
  }
}

function normalizeSourceControlConnectionUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString();
}

const SafeSourceControlConnectionUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SOURCE_CONTROL_CONNECTION_URL_MAX_LENGTH),
  Schema.makeFilter(isSafeSourceControlConnectionUrl),
);

export const SourceControlConnectionUrl = SafeSourceControlConnectionUrl.pipe(
  Schema.decodeTo(
    SafeSourceControlConnectionUrl,
    SchemaTransformation.transform({
      decode: normalizeSourceControlConnectionUrl,
      encode: normalizeSourceControlConnectionUrl,
    }),
  ),
  Schema.brand("SourceControlConnectionUrl"),
);
export type SourceControlConnectionUrl = typeof SourceControlConnectionUrl.Type;

export const SourceControlConnectionId = TrimmedNonEmptyString.check(Schema.isUUID(4)).pipe(
  Schema.brand("SourceControlConnectionId"),
);
export type SourceControlConnectionId = typeof SourceControlConnectionId.Type;

export const SourceControlConnectionProviderKind = Schema.Literal("forgejo");
export type SourceControlConnectionProviderKind = typeof SourceControlConnectionProviderKind.Type;

export const SourceControlConnectionCapabilities = Schema.Struct({
  repositorySearch: Schema.Boolean,
  repositoryCreate: Schema.Boolean,
  changeRequestList: Schema.Boolean,
  changeRequestCreate: Schema.Boolean,
  changeRequestCheckout: Schema.Boolean,
});
export type SourceControlConnectionCapabilities = typeof SourceControlConnectionCapabilities.Type;

export const SourceControlConnectionIdentity = Schema.Struct({
  login: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  avatarUrl: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlConnectionIdentity = typeof SourceControlConnectionIdentity.Type;

export const SourceControlConnection = Schema.Struct({
  id: SourceControlConnectionId,
  provider: SourceControlConnectionProviderKind,
  displayName: TrimmedNonEmptyString,
  baseUrl: SourceControlConnectionUrl,
  apiUrl: SourceControlConnectionUrl,
  identity: SourceControlConnectionIdentity,
  serverVersion: TrimmedNonEmptyString,
  capabilities: SourceControlConnectionCapabilities,
  credentialConfigured: Schema.Literal(true),
  verifiedAt: Schema.DateTimeUtc,
});
export type SourceControlConnection = typeof SourceControlConnection.Type;

const SourceControlConnectionToken = Schema.String.check(
  Schema.isMaxLength(SOURCE_CONTROL_CONNECTION_TOKEN_MAX_LENGTH),
  Schema.makeFilter((token) => token.trim().length > 0 || "A credential token is required."),
);

export const SourceControlConnectionAddInput = Schema.Struct({
  provider: SourceControlConnectionProviderKind,
  displayName: TrimmedNonEmptyString,
  baseUrl: SourceControlConnectionUrl,
  apiUrl: Schema.optional(SourceControlConnectionUrl),
  token: SourceControlConnectionToken,
});
export type SourceControlConnectionAddInput = typeof SourceControlConnectionAddInput.Type;

export const SourceControlConnectionReplaceCredentialInput = Schema.Struct({
  id: SourceControlConnectionId,
  token: SourceControlConnectionToken,
});
export type SourceControlConnectionReplaceCredentialInput =
  typeof SourceControlConnectionReplaceCredentialInput.Type;

export const SourceControlConnectionListInput = Schema.Struct({});
export type SourceControlConnectionListInput = typeof SourceControlConnectionListInput.Type;

export const SourceControlConnectionVerifyInput = Schema.Struct({
  id: SourceControlConnectionId,
});
export type SourceControlConnectionVerifyInput = typeof SourceControlConnectionVerifyInput.Type;

export const SourceControlConnectionRemoveInput = Schema.Struct({
  id: SourceControlConnectionId,
});
export type SourceControlConnectionRemoveInput = typeof SourceControlConnectionRemoveInput.Type;

export const SourceControlConnectionListResult = Schema.Struct({
  connections: Schema.Array(SourceControlConnection),
});
export type SourceControlConnectionListResult = typeof SourceControlConnectionListResult.Type;

export const SourceControlConnectionAddResult = Schema.Struct({
  connection: SourceControlConnection,
});
export type SourceControlConnectionAddResult = typeof SourceControlConnectionAddResult.Type;

export const SourceControlConnectionVerifyResult = Schema.Struct({
  connection: SourceControlConnection,
});
export type SourceControlConnectionVerifyResult = typeof SourceControlConnectionVerifyResult.Type;

export const SourceControlConnectionRemoveResult = Schema.Struct({
  id: SourceControlConnectionId,
});
export type SourceControlConnectionRemoveResult = typeof SourceControlConnectionRemoveResult.Type;

export class SourceControlConnectionInvalidUrlError extends Schema.TaggedErrorClass<SourceControlConnectionInvalidUrlError>()(
  "SourceControlConnectionInvalidUrlError",
  {
    field: Schema.Literals(["baseUrl", "apiUrl"]),
    reason: Schema.Literals(["invalid", "credentials", "query", "fragment", "insecure"]),
  },
) {
  override get message(): string {
    return `The source-control ${this.field} is invalid (${this.reason}).`;
  }
}

export class SourceControlConnectionNotFoundError extends Schema.TaggedErrorClass<SourceControlConnectionNotFoundError>()(
  "SourceControlConnectionNotFoundError",
  {
    connectionId: Schema.optional(SourceControlConnectionId),
    origin: Schema.optional(SourceControlConnectionUrl),
  },
) {
  override get message(): string {
    return "The source-control connection was not found.";
  }
}

export class SourceControlConnectionAmbiguousError extends Schema.TaggedErrorClass<SourceControlConnectionAmbiguousError>()(
  "SourceControlConnectionAmbiguousError",
  {
    origin: SourceControlConnectionUrl,
    connectionIds: Schema.Array(SourceControlConnectionId),
  },
) {
  override get message(): string {
    return "Multiple source-control connections match this origin.";
  }
}

export class SourceControlConnectionAlreadyExistsError extends Schema.TaggedErrorClass<SourceControlConnectionAlreadyExistsError>()(
  "SourceControlConnectionAlreadyExistsError",
  {
    connectionId: SourceControlConnectionId,
  },
) {
  override get message(): string {
    return "The source-control connection already exists.";
  }
}

export class SourceControlConnectionAuthenticationError extends Schema.TaggedErrorClass<SourceControlConnectionAuthenticationError>()(
  "SourceControlConnectionAuthenticationError",
  {
    provider: SourceControlConnectionProviderKind,
    connectionId: Schema.optional(SourceControlConnectionId),
  },
) {
  override get message(): string {
    return `Authentication failed for the ${this.provider} connection.`;
  }
}

export class SourceControlConnectionIncompatibleVersionError extends Schema.TaggedErrorClass<SourceControlConnectionIncompatibleVersionError>()(
  "SourceControlConnectionIncompatibleVersionError",
  {
    provider: SourceControlConnectionProviderKind,
    serverVersion: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `The ${this.provider} server version is not supported.`;
  }
}

export class SourceControlConnectionProviderUnavailableError extends Schema.TaggedErrorClass<SourceControlConnectionProviderUnavailableError>()(
  "SourceControlConnectionProviderUnavailableError",
  {
    provider: SourceControlConnectionProviderKind,
  },
) {
  override get message(): string {
    return `No verifier is registered for ${this.provider}.`;
  }
}

export const SourceControlConnectionPersistenceOperation = Schema.Literals([
  "read-metadata",
  "decode-metadata",
  "write-metadata",
  "read-credential",
  "write-credential",
  "remove-credential",
  "rollback-credential",
  "generate-id",
]);
export type SourceControlConnectionPersistenceOperation =
  typeof SourceControlConnectionPersistenceOperation.Type;

export class SourceControlConnectionPersistenceError extends Schema.TaggedErrorClass<SourceControlConnectionPersistenceError>()(
  "SourceControlConnectionPersistenceError",
  {
    operation: SourceControlConnectionPersistenceOperation,
  },
) {
  override get message(): string {
    return `Failed to persist source-control connections (${this.operation}).`;
  }
}

export const SourceControlConnectionError = Schema.Union([
  SourceControlConnectionInvalidUrlError,
  SourceControlConnectionNotFoundError,
  SourceControlConnectionAmbiguousError,
  SourceControlConnectionAlreadyExistsError,
  SourceControlConnectionAuthenticationError,
  SourceControlConnectionIncompatibleVersionError,
  SourceControlConnectionProviderUnavailableError,
  SourceControlConnectionPersistenceError,
]);
export type SourceControlConnectionError = typeof SourceControlConnectionError.Type;

export const SourceControlProviderKind = Schema.Literals([
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
export type SourceControlProviderKind = typeof SourceControlProviderKind.Type;

export const SourceControlProviderInfo = Schema.Struct({
  kind: SourceControlProviderKind,
  name: TrimmedNonEmptyString,
  baseUrl: Schema.String,
});
export type SourceControlProviderInfo = typeof SourceControlProviderInfo.Type;

export const ChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
export type ChangeRequestState = typeof ChangeRequestState.Type;

export const ChangeRequest = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: ChangeRequestState,
  updatedAt: Schema.Option(Schema.DateTimeUtc),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepositoryNameWithOwner: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headRepositoryOwnerLogin: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ChangeRequest = typeof ChangeRequest.Type;

export const SourceControlRepositoryCloneUrls = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
export type SourceControlRepositoryCloneUrls = typeof SourceControlRepositoryCloneUrls.Type;

export const SourceControlRepositoryVisibility = Schema.Literals(["private", "public"]);
export type SourceControlRepositoryVisibility = typeof SourceControlRepositoryVisibility.Type;

export const SourceControlCloneProtocol = Schema.Literals(["auto", "ssh", "https"]);
export type SourceControlCloneProtocol = typeof SourceControlCloneProtocol.Type;

export const SourceControlRepositoryInfo = Schema.Struct({
  provider: SourceControlProviderKind,
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
export type SourceControlRepositoryInfo = typeof SourceControlRepositoryInfo.Type;

export const SourceControlRepositoryLookupInput = Schema.Struct({
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlRepositoryLookupInput = typeof SourceControlRepositoryLookupInput.Type;

export const SourceControlCloneRepositoryInput = Schema.Struct({
  provider: Schema.optional(SourceControlProviderKind),
  repository: Schema.optional(TrimmedNonEmptyString),
  remoteUrl: Schema.optional(TrimmedNonEmptyString),
  destinationPath: TrimmedNonEmptyString,
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlCloneRepositoryInput = typeof SourceControlCloneRepositoryInput.Type;

export const SourceControlCloneRepositoryResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  repository: Schema.NullOr(SourceControlRepositoryInfo),
});
export type SourceControlCloneRepositoryResult = typeof SourceControlCloneRepositoryResult.Type;

export const SourceControlPublishRepositoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  visibility: SourceControlRepositoryVisibility,
  remoteName: Schema.optional(TrimmedNonEmptyString),
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlPublishRepositoryInput = typeof SourceControlPublishRepositoryInput.Type;

export const SourceControlPublishStatus = Schema.Literals(["pushed", "remote_added"]);
export type SourceControlPublishStatus = typeof SourceControlPublishStatus.Type;

export const SourceControlPublishRepositoryResult = Schema.Struct({
  repository: SourceControlRepositoryInfo,
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  upstreamBranch: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlPublishStatus,
});
export type SourceControlPublishRepositoryResult = typeof SourceControlPublishRepositoryResult.Type;

export const SourceControlDiscoveryStatus = Schema.Literals(["available", "missing"]);
export type SourceControlDiscoveryStatus = typeof SourceControlDiscoveryStatus.Type;

export const SourceControlProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type SourceControlProviderAuthStatus = typeof SourceControlProviderAuthStatus.Type;

export const SourceControlProviderAuth = Schema.Struct({
  status: SourceControlProviderAuthStatus,
  account: Schema.Option(TrimmedNonEmptyString),
  host: Schema.Option(TrimmedNonEmptyString),
  detail: Schema.Option(TrimmedNonEmptyString),
});
export type SourceControlProviderAuth = typeof SourceControlProviderAuth.Type;

const SourceControlDiscoverySharedFields = {
  label: TrimmedNonEmptyString,
  executable: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlDiscoveryStatus,
  version: Schema.Option(TrimmedNonEmptyString),
  installHint: TrimmedNonEmptyString,
  detail: Schema.Option(TrimmedNonEmptyString),
} as const;

export const VcsDiscoveryItem = Schema.Struct({
  kind: VcsDriverKind,
  implemented: Schema.Boolean,
  ...SourceControlDiscoverySharedFields,
});
export type VcsDiscoveryItem = typeof VcsDiscoveryItem.Type;

export const SourceControlProviderDiscoveryItem = Schema.Struct({
  kind: SourceControlProviderKind,
  ...SourceControlDiscoverySharedFields,
  auth: SourceControlProviderAuth,
});
export type SourceControlProviderDiscoveryItem = typeof SourceControlProviderDiscoveryItem.Type;

export const SourceControlDiscoveryResult = Schema.Struct({
  versionControlSystems: Schema.Array(VcsDiscoveryItem),
  sourceControlProviders: Schema.Array(SourceControlProviderDiscoveryItem),
});
export type SourceControlDiscoveryResult = typeof SourceControlDiscoveryResult.Type;

export class SourceControlProviderError extends Schema.TaggedErrorClass<SourceControlProviderError>()(
  "SourceControlProviderError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    cwd: Schema.String,
    command: Schema.optional(Schema.String),
    repository: Schema.optional(Schema.String),
    reference: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control provider ${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

export class SourceControlRepositoryError extends Schema.TaggedErrorClass<SourceControlRepositoryError>()(
  "SourceControlRepositoryError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control repository operation ${this.operation} failed for ${this.provider}: ${this.detail}`;
  }
}

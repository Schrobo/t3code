import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  SourceControlConnectionAuthenticationError,
  SourceControlConnectionIncompatibleVersionError,
  SourceControlConnectionSshHost,
  SourceControlConnectionUrl,
  type SourceControlConnectionCapabilities,
  type SourceControlConnectionId,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { retryAtFromHeader } from "../SourceControlRateLimit.ts";
import type { SourceControlConnectionVerifier } from "../connections/SourceControlConnectionVerifierRegistry.ts";
import {
  ForgejoApiSettingsSchema,
  ForgejoPullRequestListSchema,
  ForgejoPullRequestSchema,
  ForgejoRepositorySchema,
  ForgejoRepositorySearchSchema,
  ForgejoServerVersionSchema,
  ForgejoUserSchema,
} from "./ForgejoSchemas.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const SUPPORTED_MAJOR_VERSIONS = new Set([15, 16]);
const isIncompatibleVersionError = Schema.is(SourceControlConnectionIncompatibleVersionError);

const ForgejoOperation = Schema.Literals([
  "verifyVersion",
  "verifySettings",
  "verifyUser",
  "searchRepositories",
  "getRepository",
  "createRepository",
  "listPullRequests",
  "findPullRequest",
  "getPullRequest",
  "createPullRequest",
  "listNativePullRequests",
  "getNativePullRequest",
  "getNativePullRequestDiff",
  "listNativePullRequestComments",
  "listNativePullRequestReviews",
  "listNativePullRequestCommits",
  "listNativeCommitStatuses",
]);
export type ForgejoOperation = typeof ForgejoOperation.Type;

export class ForgejoRequestError extends Schema.TaggedErrorClass<ForgejoRequestError>()(
  "ForgejoRequestError",
  { operation: ForgejoOperation },
) {
  override get message(): string {
    return `Forgejo request failed in ${this.operation}.`;
  }
}

export class ForgejoResponseError extends Schema.TaggedErrorClass<ForgejoResponseError>()(
  "ForgejoResponseError",
  {
    operation: ForgejoOperation,
    status: Schema.Int,
    responseBodyLength: NonNegativeInt,
    requestId: Schema.optional(Schema.String),
    retryAt: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return `Forgejo returned HTTP ${this.status} in ${this.operation}.`;
  }
}

export class ForgejoResponseDecodeError extends Schema.TaggedErrorClass<ForgejoResponseDecodeError>()(
  "ForgejoResponseDecodeError",
  {
    operation: ForgejoOperation,
    status: Schema.Int,
    responseBodyLength: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Forgejo returned an invalid response in ${this.operation}.`;
  }
}

export class ForgejoUntrustedUrlError extends Schema.TaggedErrorClass<ForgejoUntrustedUrlError>()(
  "ForgejoUntrustedUrlError",
  { operation: ForgejoOperation },
) {
  override get message(): string {
    return `Forgejo refused an untrusted URL in ${this.operation}.`;
  }
}

export type ForgejoHttpError =
  | ForgejoRequestError
  | ForgejoResponseError
  | ForgejoResponseDecodeError
  | ForgejoUntrustedUrlError;

export interface ForgejoRequestConnection {
  readonly id?: SourceControlConnectionId;
  readonly baseUrl: SourceControlConnectionUrl;
  readonly apiUrl: SourceControlConnectionUrl;
  readonly token: string;
}

export interface ForgejoJsonResponse<A> {
  readonly value: A;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface ForgejoTextResponse {
  readonly value: string;
  readonly truncated: boolean;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export class ForgejoHttpClient extends Context.Service<
  ForgejoHttpClient,
  {
    readonly requestJson: <S extends Schema.Top>(input: {
      readonly connection: ForgejoRequestConnection;
      readonly operation: ForgejoOperation;
      readonly pathOrUrl: string;
      readonly method?: "GET" | "POST";
      readonly body?: unknown;
      readonly schema: S;
    }) => Effect.Effect<ForgejoJsonResponse<S["Type"]>, ForgejoHttpError, S["DecodingServices"]>;
    readonly requestText: (input: {
      readonly connection: ForgejoRequestConnection;
      readonly operation: ForgejoOperation;
      readonly pathOrUrl: string;
      readonly maxBytes?: number;
    }) => Effect.Effect<ForgejoTextResponse, ForgejoHttpError>;
  }
>()("t3/sourceControl/forgejo/ForgejoHttpClient") {}

function trustedApiUrl(connection: ForgejoRequestConnection, pathOrUrl: string): URL | null {
  try {
    const api = new URL(connection.apiUrl);
    const target = new URL(pathOrUrl, `${api.toString().replace(/\/+$/u, "")}/`);
    const apiPath = api.pathname.replace(/\/+$/u, "");
    if (target.origin !== api.origin) return null;
    if (target.pathname !== apiPath && !target.pathname.startsWith(`${apiPath}/`)) return null;
    return target;
  } catch {
    return null;
  }
}

function deriveApiUrl(baseUrl: SourceControlConnectionUrl): SourceControlConnectionUrl {
  return SourceControlConnectionUrl.make(`${baseUrl.replace(/\/+$/u, "")}/api/v1`);
}

function optionalTrimmed(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

export const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;

  const send = (input: {
    readonly connection: ForgejoRequestConnection;
    readonly operation: ForgejoOperation;
    readonly pathOrUrl: string;
    readonly method: "GET" | "POST";
    readonly body?: unknown;
    readonly redirects: number;
  }): Effect.Effect<HttpClientResponse.HttpClientResponse, ForgejoHttpError> => {
    const url = trustedApiUrl(input.connection, input.pathOrUrl);
    if (url === null)
      return Effect.fail(new ForgejoUntrustedUrlError({ operation: input.operation }));

    const base = input.method === "POST" ? HttpClientRequest.post(url) : HttpClientRequest.get(url);
    const withBody =
      input.body === undefined ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body));
    const request = withBody.pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.setHeader("authorization", `token ${input.connection.token}`),
    );

    return http.execute(request).pipe(
      Effect.mapError(() => new ForgejoRequestError({ operation: input.operation })),
      Effect.flatMap((response) => {
        const location = response.headers.location;
        if (response.status >= 300 && response.status < 400 && location !== undefined) {
          if (input.redirects >= MAX_REDIRECTS) {
            return Effect.fail(new ForgejoUntrustedUrlError({ operation: input.operation }));
          }
          const redirected = new URL(location, url).toString();
          if (trustedApiUrl(input.connection, redirected) === null) {
            return Effect.fail(new ForgejoUntrustedUrlError({ operation: input.operation }));
          }
          return send({ ...input, pathOrUrl: redirected, redirects: input.redirects + 1 });
        }
        return Effect.succeed(response);
      }),
    );
  };

  const requestJson: ForgejoHttpClient["Service"]["requestJson"] = (input) =>
    send({
      connection: input.connection,
      operation: input.operation,
      pathOrUrl: input.pathOrUrl,
      method: input.method ?? "GET",
      ...(input.body === undefined ? {} : { body: input.body }),
      redirects: 0,
    }).pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          const collected = yield* collectUint8StreamText({
            stream: response.stream,
            maxBytes: MAX_RESPONSE_BYTES,
          }).pipe(Effect.mapError(() => new ForgejoRequestError({ operation: input.operation })));
          if (response.status < 200 || response.status >= 300) {
            const now = yield* Clock.currentTimeMillis;
            return yield* new ForgejoResponseError({
              operation: input.operation,
              status: response.status,
              responseBodyLength: collected.bytes,
              ...(optionalTrimmed(response.headers["x-request-id"])
                ? { requestId: optionalTrimmed(response.headers["x-request-id"])! }
                : {}),
              ...(retryAtFromHeader(response.headers["retry-after"], now) === undefined
                ? {}
                : { retryAt: retryAtFromHeader(response.headers["retry-after"], now)! }),
            });
          }
          if (collected.truncated || collected.invalidUtf8) {
            return yield* new ForgejoResponseDecodeError({
              operation: input.operation,
              status: response.status,
              responseBodyLength: collected.bytes,
            });
          }
          // oxlint-disable-next-line t3code/no-inline-schema-compile -- The response schema is selected by each request.
          const value = yield* Schema.decodeEffect(Schema.fromJsonString(input.schema))(
            collected.text,
          ).pipe(
            Effect.mapError(
              () =>
                new ForgejoResponseDecodeError({
                  operation: input.operation,
                  status: response.status,
                  responseBodyLength: collected.bytes,
                }),
            ),
          );
          return { value, headers: response.headers };
        }),
      ),
    );

  const requestText: ForgejoHttpClient["Service"]["requestText"] = (input) =>
    send({
      connection: input.connection,
      operation: input.operation,
      pathOrUrl: input.pathOrUrl,
      method: "GET",
      redirects: 0,
    }).pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          const collected = yield* collectUint8StreamText({
            stream: response.stream,
            maxBytes: input.maxBytes ?? MAX_RESPONSE_BYTES,
          }).pipe(Effect.mapError(() => new ForgejoRequestError({ operation: input.operation })));
          if (response.status < 200 || response.status >= 300) {
            const now = yield* Clock.currentTimeMillis;
            return yield* new ForgejoResponseError({
              operation: input.operation,
              status: response.status,
              responseBodyLength: collected.bytes,
              ...(optionalTrimmed(response.headers["x-request-id"])
                ? { requestId: optionalTrimmed(response.headers["x-request-id"])! }
                : {}),
              ...(retryAtFromHeader(response.headers["retry-after"], now) === undefined
                ? {}
                : { retryAt: retryAtFromHeader(response.headers["retry-after"], now)! }),
            });
          }
          if (collected.invalidUtf8) {
            return yield* new ForgejoResponseDecodeError({
              operation: input.operation,
              status: response.status,
              responseBodyLength: collected.bytes,
            });
          }
          return {
            value: collected.text,
            truncated: collected.truncated,
            headers: response.headers,
          };
        }),
      ),
    );

  return ForgejoHttpClient.of({ requestJson, requestText });
});

export const layer = Layer.effect(ForgejoHttpClient, make);

const verifiedCapabilities: SourceControlConnectionCapabilities = {
  repositorySearch: true,
  repositoryCreate: true,
  changeRequestList: true,
  changeRequestCreate: true,
  changeRequestCheckout: true,
};

export const makeVerifier = Effect.gen(function* () {
  const client = yield* ForgejoHttpClient;

  const verifier: SourceControlConnectionVerifier = (input) => {
    const apiUrl = input.apiUrl ?? deriveApiUrl(input.baseUrl);
    const connection: ForgejoRequestConnection = {
      ...(input.connectionId === undefined ? {} : { id: input.connectionId }),
      baseUrl: input.baseUrl,
      apiUrl,
      token: input.token,
    };

    return Effect.gen(function* () {
      const versionResponse = yield* client.requestJson({
        connection,
        operation: "verifyVersion",
        pathOrUrl: "version",
        schema: ForgejoServerVersionSchema,
      });
      const majorVersion = Number.parseInt(versionResponse.value.version.split(".")[0] ?? "", 10);
      if (!SUPPORTED_MAJOR_VERSIONS.has(majorVersion)) {
        return yield* new SourceControlConnectionIncompatibleVersionError({
          provider: "forgejo",
          serverVersion: versionResponse.value.version,
        });
      }

      yield* client.requestJson({
        connection,
        operation: "verifySettings",
        pathOrUrl: "settings/api",
        schema: ForgejoApiSettingsSchema,
      });
      const user = yield* client.requestJson({
        connection,
        operation: "verifyUser",
        pathOrUrl: "user",
        schema: ForgejoUserSchema,
      });

      return {
        baseUrl: input.baseUrl,
        apiUrl,
        sshHost:
          input.sshHost ?? SourceControlConnectionSshHost.make(new URL(input.baseUrl).hostname),
        sshPort: input.sshPort ?? 22,
        identity: {
          login: user.value.login,
          ...(optionalTrimmed(user.value.full_name)
            ? { displayName: optionalTrimmed(user.value.full_name)! }
            : {}),
          ...(optionalTrimmed(user.value.avatar_url)
            ? { avatarUrl: optionalTrimmed(user.value.avatar_url)! }
            : {}),
        },
        serverVersion: versionResponse.value.version,
        capabilities: verifiedCapabilities,
      };
    }).pipe(
      Effect.mapError((error) => {
        if (isIncompatibleVersionError(error)) return error;
        return new SourceControlConnectionAuthenticationError({
          provider: "forgejo",
          ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
        });
      }),
    );
  };

  return verifier;
});

export const schemas = {
  repository: ForgejoRepositorySchema,
  repositorySearch: ForgejoRepositorySearchSchema,
  pullRequest: ForgejoPullRequestSchema,
  pullRequestList: ForgejoPullRequestListSchema,
};

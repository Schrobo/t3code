import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  SourceControlConnectionAuthenticationError,
  SourceControlConnectionIncompatibleVersionError,
  SourceControlConnectionUrl,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  ForgejoHttpClient,
  ForgejoResponseError,
  ForgejoUntrustedUrlError,
  layer,
  makeVerifier,
  schemas,
} from "./ForgejoHttpClient.ts";

const token = "sensitive-forgejo-test-token";
const connection = {
  baseUrl: SourceControlConnectionUrl.make("https://forgejo.test/forge/"),
  apiUrl: SourceControlConnectionUrl.make("https://forgejo.test/forge/api/v1"),
  token,
};

function makeLayer(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))),
  );
  return {
    execute,
    layer: layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
    ),
  };
}

it.effect("sends Forgejo token auth only to the configured API origin and base path", () => {
  const { execute, layer: testLayer } = makeLayer((request) =>
    Response.json({
      full_name: "owner/repo",
      html_url: "https://forgejo.test/forge/owner/repo",
      clone_url: "https://forgejo.test/forge/owner/repo.git",
      ssh_url: "git@forgejo.test:owner/repo.git",
      private: true,
      default_branch: "main",
      owner: { login: "owner" },
    }),
  );

  return Effect.gen(function* () {
    const client = yield* ForgejoHttpClient;
    yield* client.requestJson({
      connection,
      operation: "getRepository",
      pathOrUrl: "repos/owner/repo",
      schema: schemas.repository,
    });

    const request = execute.mock.calls[0]?.[0];
    assert.equal(request?.url, "https://forgejo.test/forge/api/v1/repos/owner/repo");
    assert.equal(request?.headers.authorization, `token ${token}`);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects a cross-origin redirect before forwarding credentials", () => {
  const { execute, layer: testLayer } = makeLayer(
    () => new Response(null, { status: 302, headers: { location: "https://attacker.test/api" } }),
  );

  return Effect.gen(function* () {
    const client = yield* ForgejoHttpClient;
    const error = yield* client
      .requestJson({
        connection,
        operation: "getRepository",
        pathOrUrl: "repos/owner/repo",
        schema: schemas.repository,
      })
      .pipe(Effect.flip);

    assert.isTrue(Schema.is(ForgejoUntrustedUrlError)(error));
    assert.equal(execute.mock.calls.length, 1);
  }).pipe(Effect.provide(testLayer));
});

it.effect(
  "sanitizes common Forgejo API failures without exposing response bodies or tokens",
  () => {
    const sensitiveBody = `invalid token ${token}`;
    let status = 401;
    const { layer: testLayer } = makeLayer(
      () =>
        new Response(sensitiveBody, {
          status,
          headers: {
            "x-request-id": `request-${status}`,
            ...(status === 429 ? { "retry-after": "60" } : {}),
          },
        }),
    );

    return Effect.gen(function* () {
      const client = yield* ForgejoHttpClient;
      for (const responseStatus of [401, 403, 404, 409, 422, 429]) {
        status = responseStatus;
        const error = yield* client
          .requestJson({
            connection,
            operation: "verifyUser",
            pathOrUrl: "user",
            schema: schemas.repository,
          })
          .pipe(Effect.flip);

        assert.isTrue(Schema.is(ForgejoResponseError)(error));
        if (!Schema.is(ForgejoResponseError)(error)) return;
        assert.equal(error.status, responseStatus);
        assert.equal(error.responseBodyLength, sensitiveBody.length);
        assert.equal(error.requestId, `request-${responseStatus}`);
        assert.equal(responseStatus === 429, error.retryAt !== undefined);
        assert.notInclude(`${error.message} ${error.requestId ?? ""}`, token);
        assert.notInclude(error.message, sensitiveBody);
      }
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect("verifies Forgejo 15 and 16 connections and rejects older major versions", () => {
  const responses = (version: string) =>
    makeLayer((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/version")) return Response.json({ version });
      if (path.endsWith("/settings/api")) {
        return Response.json({ default_paging_num: 30, max_response_items: 50 });
      }
      return Response.json({ login: "schrobo", full_name: "Schrobo" });
    }).layer;

  return Effect.gen(function* () {
    for (const version of ["15.0.7", "16.0.3"] as const) {
      const verifier = yield* makeVerifier.pipe(Effect.provide(responses(version)));
      const verified = yield* verifier({
        provider: "forgejo",
        baseUrl: connection.baseUrl,
        token,
      });
      assert.equal(verified.apiUrl, "https://forgejo.test/forge/api/v1");
      assert.equal(verified.identity.login, "schrobo");
      assert.equal(verified.serverVersion, version);
    }

    const oldVerifier = yield* makeVerifier.pipe(Effect.provide(responses("14.0.0")));
    const incompatible = yield* oldVerifier({
      provider: "forgejo",
      baseUrl: connection.baseUrl,
      token,
    }).pipe(Effect.flip);
    assert.isTrue(Schema.is(SourceControlConnectionIncompatibleVersionError)(incompatible));

    const authFailureLayer = makeLayer(() => new Response("denied", { status: 401 })).layer;
    const failingVerifier = yield* makeVerifier.pipe(Effect.provide(authFailureLayer));
    const authentication = yield* failingVerifier({
      provider: "forgejo",
      baseUrl: connection.baseUrl,
      token,
    }).pipe(Effect.flip);
    assert.isTrue(Schema.is(SourceControlConnectionAuthenticationError)(authentication));
  });
});

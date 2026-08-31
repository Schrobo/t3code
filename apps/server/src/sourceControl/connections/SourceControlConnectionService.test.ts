import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  SourceControlConnectionAddInput,
  SourceControlConnectionAmbiguousError,
  SourceControlConnectionAuthenticationError,
  SourceControlConnectionId,
  SourceControlConnectionPersistenceError,
  SourceControlConnectionUrl,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  SourceControlConnectionService,
  layer as serviceLayer,
} from "./SourceControlConnectionService.ts";
import * as SourceControlConnectionStore from "./SourceControlConnectionStore.ts";
import type { StoredSourceControlConnection } from "./SourceControlConnectionStore.ts";
import * as SourceControlConnectionVerifierRegistry from "./SourceControlConnectionVerifierRegistry.ts";

const decodeAddInput = Schema.decodeUnknownSync(SourceControlConnectionAddInput);
const capabilities = {
  repositorySearch: true,
  repositoryCreate: true,
  changeRequestList: true,
  changeRequestCreate: true,
  changeRequestCheckout: true,
} as const;

const verifier: SourceControlConnectionVerifierRegistry.SourceControlConnectionVerifier = (input) =>
  input.token === "rejected-sensitive-fixture"
    ? Effect.fail(
        new SourceControlConnectionAuthenticationError({
          provider: input.provider,
          ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
        }),
      )
    : Effect.succeed({
        baseUrl: input.baseUrl,
        apiUrl:
          input.apiUrl ??
          SourceControlConnectionUrl.make(new URL("api/v1", input.baseUrl).toString()),
        identity: { login: `user-${input.token.length}` },
        serverVersion: "12.0.0",
        capabilities,
      });

const makeLayer = () => {
  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-sc-service-" });
  const storeLayer = SourceControlConnectionStore.layer.pipe(Layer.provide(configLayer));
  const secretLayer = ServerSecretStore.layer.pipe(Layer.provide(configLayer));
  return serviceLayer.pipe(
    Layer.provide(SourceControlConnectionVerifierRegistry.layer({ forgejo: verifier })),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(secretLayer),
  );
};

const addInput = (displayName: string, baseUrl = "https://git.example.com/") =>
  decodeAddInput({
    provider: "forgejo",
    displayName,
    baseUrl,
    token: `credential-${displayName}`,
  });

const rollbackConnectionId = SourceControlConnectionId.make("00000000-0000-4000-8000-000000000099");
const rollbackCredentialRef = `source-control-connection-${rollbackConnectionId}`;
const rollbackConnection: StoredSourceControlConnection = {
  id: rollbackConnectionId,
  provider: "forgejo",
  displayName: "Rollback Forgejo",
  baseUrl: SourceControlConnectionUrl.make("https://rollback.example.com/"),
  apiUrl: SourceControlConnectionUrl.make("https://rollback.example.com/api/v1"),
  identity: { login: "rollback" },
  serverVersion: "12.0.0",
  capabilities,
  credentialConfigured: true,
  verifiedAt: DateTime.makeUnsafe("2026-08-31T12:00:00.000Z"),
  credentialRef: rollbackCredentialRef,
};

const makeFailureLayer = (input: {
  readonly initialConnections: ReadonlyArray<StoredSourceControlConnection>;
  readonly initialCredentials?: ReadonlyMap<string, Uint8Array>;
  readonly failAdd?: boolean;
  readonly failRemove?: boolean;
}) => {
  const connections = [...input.initialConnections];
  const credentials = new Map(input.initialCredentials);
  const persistenceFailure = () =>
    new SourceControlConnectionPersistenceError({ operation: "write-metadata" });
  const store = SourceControlConnectionStore.SourceControlConnectionStore.of({
    list: Effect.succeed(connections),
    get: (id) => Effect.succeed(connections.find((connection) => connection.id === id)!),
    add: (connection) =>
      input.failAdd
        ? Effect.fail(persistenceFailure())
        : Effect.sync(() => {
            connections.push(connection);
          }),
    replace: () => Effect.void,
    remove: (id) =>
      input.failRemove
        ? Effect.fail(persistenceFailure())
        : Effect.sync(() => connections.find((connection) => connection.id === id)!),
  });
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(credentials.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        credentials.set(name, Uint8Array.from(value));
      }),
    create: (name, value) =>
      Effect.sync(() => {
        credentials.set(name, Uint8Array.from(value));
      }),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) =>
      Effect.sync(() => {
        credentials.delete(name);
      }),
  });
  const layer = serviceLayer.pipe(
    Layer.provide(SourceControlConnectionVerifierRegistry.layer({ forgejo: verifier })),
    Layer.provide(Layer.succeed(SourceControlConnectionStore.SourceControlConnectionStore, store)),
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets)),
  );
  return { layer, credentials };
};

it.layer(NodeServices.layer)("SourceControlConnectionService", (it) => {
  it.effect("supports multiple instances and accounts without returning credentials", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlConnectionService;
      const first = yield* service.add(addInput("primary"));
      const second = yield* service.add(addInput("secondary"));
      const third = yield* service.add(addInput("other", "https://git.other.example:8443/"));

      const listed = yield* service.list;
      assert.equal(listed.length, 3);
      assert.notEqual(first.id, second.id);
      assert.equal(third.baseUrl, "https://git.other.example:8443/");
      assert.isFalse(listed.some((connection) => "token" in connection));
      assert.isFalse(listed.some((connection) => "credentialRef" in connection));

      const ambiguity = yield* Effect.flip(
        service.resolveByOrigin(
          SourceControlConnectionUrl.make("https://git.example.com/owner/repo"),
        ),
      );
      assert.instanceOf(ambiguity, SourceControlConnectionAmbiguousError);

      const resolved = yield* service.resolveByOrigin(
        SourceControlConnectionUrl.make("https://git.other.example:8443/owner/repo"),
      );
      assert.equal(resolved.connection.id, third.id);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("verifies, replaces credentials, and removes both metadata and secret", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlConnectionService;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const created = yield* service.add(addInput("replaceable"));

      const verified = yield* service.verify(created.id);
      const replaced = yield* service.replaceCredential({
        id: created.id,
        token: "replacement-sensitive-fixture",
      });
      const resolved = yield* service.resolveById(created.id);

      assert.equal(verified.id, created.id);
      assert.equal(replaced.id, created.id);
      assert.equal(resolved.token, "replacement-sensitive-fixture");

      yield* service.remove(created.id);
      assert.equal((yield* service.list).length, 0);
      assert.isTrue(
        Option.isNone(yield* secretStore.get(`source-control-connection-${created.id}`)),
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("returns sanitized authentication failures", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlConnectionService;
      const input = decodeAddInput({
        provider: "forgejo",
        displayName: "rejected",
        baseUrl: "https://git.example.com/",
        token: "rejected-sensitive-fixture",
      });

      const error = yield* Effect.flip(service.add(input));

      assert.instanceOf(error, SourceControlConnectionAuthenticationError);
      assert.notInclude(error.message, input.token);
      assert.equal((yield* service.list).length, 0);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("rolls back a newly created secret when metadata persistence fails", () => {
    const failure = makeFailureLayer({
      initialConnections: [],
      failAdd: true,
    });
    return Effect.gen(function* () {
      const service = yield* SourceControlConnectionService;
      const error = yield* Effect.flip(service.add(addInput("rollback-add")));

      assert.instanceOf(error, SourceControlConnectionPersistenceError);
      assert.equal(failure.credentials.size, 0);
    }).pipe(Effect.provide(failure.layer));
  });

  it.effect("restores a removed secret when metadata removal fails", () => {
    const previousCredential = new TextEncoder().encode("previous-sensitive-fixture");
    const failure = makeFailureLayer({
      initialConnections: [rollbackConnection],
      initialCredentials: new Map([[rollbackCredentialRef, previousCredential]]),
      failRemove: true,
    });
    return Effect.gen(function* () {
      const service = yield* SourceControlConnectionService;
      const error = yield* Effect.flip(service.remove(rollbackConnectionId));

      assert.instanceOf(error, SourceControlConnectionPersistenceError);
      assert.deepEqual(
        Array.from(failure.credentials.get(rollbackCredentialRef) ?? []),
        Array.from(previousCredential),
      );
    }).pipe(Effect.provide(failure.layer));
  });
});

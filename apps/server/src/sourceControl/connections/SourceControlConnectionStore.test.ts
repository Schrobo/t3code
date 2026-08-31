import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  SourceControlConnectionAlreadyExistsError,
  SourceControlConnectionId,
  SourceControlConnectionPersistenceError,
  SourceControlConnectionUrl,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import {
  SourceControlConnectionStore,
  layer as storeLayer,
  make,
  type StoredSourceControlConnection,
} from "./SourceControlConnectionStore.ts";

const connectionId = SourceControlConnectionId.make("00000000-0000-4000-8000-000000000001");

const fixture = (id = connectionId): StoredSourceControlConnection => ({
  id,
  provider: "forgejo",
  displayName: "Work Forgejo",
  baseUrl: SourceControlConnectionUrl.make("https://git.example.com/"),
  apiUrl: SourceControlConnectionUrl.make("https://git.example.com/api/v1"),
  sshHost: "git.example.com" as StoredSourceControlConnection["sshHost"],
  sshPort: 22,
  identity: { login: "octo" },
  serverVersion: "12.0.0",
  capabilities: {
    repositorySearch: true,
    repositoryCreate: true,
    changeRequestList: true,
    changeRequestCreate: true,
    changeRequestCheckout: true,
  },
  credentialConfigured: true,
  verifiedAt: DateTime.makeUnsafe("2026-08-31T12:00:00.000Z"),
  credentialRef: `source-control-connection-${id}`,
});

const makeLayer = () =>
  storeLayer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sc-connections-" })),
  );

it.layer(NodeServices.layer)("SourceControlConnectionStore", (it) => {
  it.effect("persists metadata across service reconstruction with mode 0600", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const first = yield* make;
      yield* first.add(fixture());

      const second = yield* make;
      const connections = yield* second.list;
      const stat = yield* Effect.promise(() => import("node:fs/promises")).pipe(
        Effect.flatMap((nodeFs) =>
          Effect.promise(() => nodeFs.stat(config.sourceControlConnectionsPath)),
        ),
      );

      assert.equal(connections.length, 1);
      assert.equal(connections[0]?.id, connectionId);
      assert.equal(stat.mode & 0o777, 0o600);
      const metadata = yield* fs.readFileString(config.sourceControlConnectionsPath);
      assert.notInclude(metadata, "sensitive-fixture-value");
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sc-connections-" })),
    ),
  );

  it.effect("serializes concurrent additions without losing entries", () =>
    Effect.gen(function* () {
      const store = yield* SourceControlConnectionStore;
      const connections = Array.from({ length: 12 }, (_, index) =>
        fixture(
          SourceControlConnectionId.make(
            `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          ),
        ),
      );

      yield* Effect.forEach(connections, store.add, { concurrency: "unbounded", discard: true });

      assert.equal((yield* store.list).length, connections.length);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("rejects duplicate stable IDs", () =>
    Effect.gen(function* () {
      const store = yield* SourceControlConnectionStore;
      yield* store.add(fixture());
      const error = yield* Effect.flip(store.add(fixture()));

      assert.instanceOf(error, SourceControlConnectionAlreadyExistsError);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("reports corrupt metadata without exposing file contents", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const store = yield* SourceControlConnectionStore;
      yield* fs.writeFileString(config.sourceControlConnectionsPath, "not-json-sensitive-value");

      const error = yield* Effect.flip(store.list);

      assert.instanceOf(error, SourceControlConnectionPersistenceError);
      assert.equal(error.operation, "decode-metadata");
      assert.notInclude(error.message, "not-json-sensitive-value");
    }).pipe(Effect.provide(makeLayer())),
  );
});

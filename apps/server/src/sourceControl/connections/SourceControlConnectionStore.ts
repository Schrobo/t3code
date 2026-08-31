import {
  PortSchema,
  SourceControlConnectionAlreadyExistsError,
  SourceControlConnectionCapabilities,
  SourceControlConnectionId,
  SourceControlConnectionIdentity,
  SourceControlConnectionNotFoundError,
  SourceControlConnectionPersistenceError,
  SourceControlConnectionProviderKind,
  SourceControlConnectionSshHost,
  SourceControlConnectionUrl,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import * as ServerConfig from "../../config.ts";

export const StoredSourceControlConnection = Schema.Struct({
  id: SourceControlConnectionId,
  provider: SourceControlConnectionProviderKind,
  displayName: TrimmedNonEmptyString,
  baseUrl: SourceControlConnectionUrl,
  apiUrl: SourceControlConnectionUrl,
  sshHost: SourceControlConnectionSshHost,
  sshPort: PortSchema,
  identity: SourceControlConnectionIdentity,
  serverVersion: TrimmedNonEmptyString,
  capabilities: SourceControlConnectionCapabilities,
  credentialConfigured: Schema.Literal(true),
  verifiedAt: Schema.DateTimeUtcFromString,
  credentialRef: TrimmedNonEmptyString,
});
export type StoredSourceControlConnection = typeof StoredSourceControlConnection.Type;

const StoredSourceControlConnectionsFile = Schema.Struct({
  version: Schema.Literal(1),
  connections: Schema.Array(StoredSourceControlConnection),
});

const StoredSourceControlConnectionsJson = fromJsonStringPretty(StoredSourceControlConnectionsFile);
const decodeFile = Schema.decodeUnknownEffect(StoredSourceControlConnectionsJson);
const encodeFile = Schema.encodeEffect(StoredSourceControlConnectionsJson);

type StoreError =
  | SourceControlConnectionAlreadyExistsError
  | SourceControlConnectionNotFoundError
  | SourceControlConnectionPersistenceError;

export class SourceControlConnectionStore extends Context.Service<
  SourceControlConnectionStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<StoredSourceControlConnection>, StoreError>;
    readonly get: (
      id: SourceControlConnectionId,
    ) => Effect.Effect<StoredSourceControlConnection, StoreError>;
    readonly add: (connection: StoredSourceControlConnection) => Effect.Effect<void, StoreError>;
    readonly replace: (
      connection: StoredSourceControlConnection,
    ) => Effect.Effect<void, StoreError>;
    readonly remove: (
      id: SourceControlConnectionId,
    ) => Effect.Effect<StoredSourceControlConnection, StoreError>;
  }
>()("t3/sourceControl/connections/SourceControlConnectionStore") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { sourceControlConnectionsPath } = yield* ServerConfig.ServerConfig;
  const mutex = yield* Semaphore.make(1);

  const load = Effect.gen(function* () {
    const exists = yield* fs
      .exists(sourceControlConnectionsPath)
      .pipe(
        Effect.mapError(
          () => new SourceControlConnectionPersistenceError({ operation: "read-metadata" }),
        ),
      );
    if (!exists) return [];

    const contents = yield* fs
      .readFileString(sourceControlConnectionsPath)
      .pipe(
        Effect.mapError(
          () => new SourceControlConnectionPersistenceError({ operation: "read-metadata" }),
        ),
      );
    const decoded = yield* decodeFile(contents).pipe(
      Effect.mapError(
        () => new SourceControlConnectionPersistenceError({ operation: "decode-metadata" }),
      ),
    );
    return decoded.connections;
  });

  const persist = (connections: ReadonlyArray<StoredSourceControlConnection>) =>
    encodeFile({ version: 1, connections }).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({
          filePath: sourceControlConnectionsPath,
          contents,
          mode: 0o600,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      ),
      Effect.mapError(
        () => new SourceControlConnectionPersistenceError({ operation: "write-metadata" }),
      ),
    );

  const getFrom = (
    connections: ReadonlyArray<StoredSourceControlConnection>,
    id: SourceControlConnectionId,
  ) => {
    const connection = connections.find((candidate) => candidate.id === id);
    return connection === undefined
      ? Effect.fail(new SourceControlConnectionNotFoundError({ connectionId: id }))
      : Effect.succeed(connection);
  };

  return SourceControlConnectionStore.of({
    list: mutex.withPermits(1)(load),
    get: (id) =>
      mutex.withPermits(1)(load.pipe(Effect.flatMap((connections) => getFrom(connections, id)))),
    add: (connection) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const connections = yield* load;
          if (connections.some((candidate) => candidate.id === connection.id)) {
            return yield* new SourceControlConnectionAlreadyExistsError({
              connectionId: connection.id,
            });
          }
          yield* persist([...connections, connection]);
        }),
      ),
    replace: (connection) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const connections = yield* load;
          yield* getFrom(connections, connection.id);
          yield* persist(
            connections.map((candidate) =>
              candidate.id === connection.id ? connection : candidate,
            ),
          );
        }),
      ),
    remove: (id) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const connections = yield* load;
          const removed = yield* getFrom(connections, id);
          yield* persist(connections.filter((candidate) => candidate.id !== id));
          return removed;
        }),
      ),
  });
});

export const layer = Layer.effect(SourceControlConnectionStore, make);

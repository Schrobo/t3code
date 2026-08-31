import {
  type SourceControlConnection,
  type SourceControlConnectionAddInput,
  SourceControlConnectionAmbiguousError,
  type SourceControlConnectionError,
  SourceControlConnectionId,
  SourceControlConnectionNotFoundError,
  SourceControlConnectionPersistenceError,
  type SourceControlConnectionReplaceCredentialInput,
  type SourceControlConnectionUrl,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { parseGitRemoteUrl } from "@t3tools/shared/git";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  SourceControlConnectionStore,
  type StoredSourceControlConnection,
} from "./SourceControlConnectionStore.ts";
import { SourceControlConnectionVerifierRegistry } from "./SourceControlConnectionVerifierRegistry.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ResolvedSourceControlConnection {
  readonly connection: SourceControlConnection;
  readonly token: string;
}

const toPublicConnection = ({
  credentialRef: _credentialRef,
  ...connection
}: StoredSourceControlConnection): SourceControlConnection => connection;

const credentialReference = (id: SourceControlConnectionId): string =>
  `source-control-connection-${id}`;

export class SourceControlConnectionService extends Context.Service<
  SourceControlConnectionService,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<SourceControlConnection>,
      SourceControlConnectionError
    >;
    readonly add: (
      input: SourceControlConnectionAddInput,
    ) => Effect.Effect<SourceControlConnection, SourceControlConnectionError>;
    readonly verify: (
      id: SourceControlConnectionId,
    ) => Effect.Effect<SourceControlConnection, SourceControlConnectionError>;
    readonly replaceCredential: (
      input: SourceControlConnectionReplaceCredentialInput,
    ) => Effect.Effect<SourceControlConnection, SourceControlConnectionError>;
    readonly remove: (
      id: SourceControlConnectionId,
    ) => Effect.Effect<void, SourceControlConnectionError>;
    readonly resolveById: (
      id: SourceControlConnectionId,
    ) => Effect.Effect<ResolvedSourceControlConnection, SourceControlConnectionError>;
    readonly resolveByOrigin: (
      origin: SourceControlConnectionUrl,
    ) => Effect.Effect<ResolvedSourceControlConnection, SourceControlConnectionError>;
    readonly resolveByRemoteUrl: (
      remoteUrl: string,
    ) => Effect.Effect<ResolvedSourceControlConnection, SourceControlConnectionError>;
  }
>()("t3/sourceControl/connections/SourceControlConnectionService") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const store = yield* SourceControlConnectionStore;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const verifiers = yield* SourceControlConnectionVerifierRegistry;
  const transactionMutex = yield* Semaphore.make(1);

  const mapCredentialError =
    (operation: "read-credential" | "write-credential" | "remove-credential") => () =>
      new SourceControlConnectionPersistenceError({ operation });

  const readCredential = (connection: StoredSourceControlConnection) =>
    secrets.get(connection.credentialRef).pipe(
      Effect.mapError(mapCredentialError("read-credential")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new SourceControlConnectionPersistenceError({ operation: "read-credential" }),
            ),
          onSome: (bytes) => Effect.succeed(decoder.decode(bytes)),
        }),
      ),
    );

  const resolveById = (id: SourceControlConnectionId) =>
    Effect.gen(function* () {
      const stored = yield* store.get(id);
      const token = yield* readCredential(stored);
      return { connection: toPublicConnection(stored), token };
    });

  const list = store.list.pipe(Effect.map((connections) => connections.map(toPublicConnection)));

  const add = (input: SourceControlConnectionAddInput) =>
    Effect.gen(function* () {
      const verified = yield* verifiers.verify({
        provider: input.provider,
        baseUrl: input.baseUrl,
        ...(input.apiUrl === undefined ? {} : { apiUrl: input.apiUrl }),
        ...(input.sshHost === undefined ? {} : { sshHost: input.sshHost }),
        ...(input.sshPort === undefined ? {} : { sshPort: input.sshPort }),
        token: input.token,
      });
      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.map(SourceControlConnectionId.make),
        Effect.mapError(
          () => new SourceControlConnectionPersistenceError({ operation: "generate-id" }),
        ),
      );
      const credentialRef = credentialReference(id);
      const stored: StoredSourceControlConnection = {
        id,
        provider: input.provider,
        displayName: input.displayName,
        ...verified,
        ...(input.sshHost === undefined ? {} : { sshHost: input.sshHost }),
        ...(input.sshPort === undefined ? {} : { sshPort: input.sshPort }),
        credentialConfigured: true,
        verifiedAt: yield* DateTime.now,
        credentialRef,
      };

      yield* transactionMutex.withPermits(1)(
        Effect.gen(function* () {
          yield* secrets
            .create(credentialRef, encoder.encode(input.token))
            .pipe(Effect.mapError(mapCredentialError("write-credential")));
          yield* store.add(stored).pipe(
            Effect.catch((error) =>
              secrets.remove(credentialRef).pipe(
                Effect.mapError(
                  () =>
                    new SourceControlConnectionPersistenceError({
                      operation: "rollback-credential",
                    }),
                ),
                Effect.flatMap(() => Effect.fail(error)),
              ),
            ),
          );
        }),
      );
      return toPublicConnection(stored);
    });

  const verifyStored = (stored: StoredSourceControlConnection, token: string) =>
    Effect.gen(function* () {
      const verified = yield* verifiers.verify({
        provider: stored.provider,
        connectionId: stored.id,
        baseUrl: stored.baseUrl,
        apiUrl: stored.apiUrl,
        sshHost: stored.sshHost,
        sshPort: stored.sshPort,
        token,
      });
      return {
        ...stored,
        ...verified,
        verifiedAt: yield* DateTime.now,
      } satisfies StoredSourceControlConnection;
    });

  const verify = (id: SourceControlConnectionId) =>
    transactionMutex.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* store.get(id);
        const token = yield* readCredential(stored);
        const updated = yield* verifyStored(stored, token);
        yield* store.replace(updated);
        return toPublicConnection(updated);
      }),
    );

  const replaceCredential = (input: SourceControlConnectionReplaceCredentialInput) =>
    transactionMutex.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* store.get(input.id);
        const previousBytes = yield* secrets.get(stored.credentialRef).pipe(
          Effect.mapError(mapCredentialError("read-credential")),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new SourceControlConnectionPersistenceError({ operation: "read-credential" }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        const updated = yield* verifyStored(stored, input.token);
        yield* secrets
          .set(stored.credentialRef, encoder.encode(input.token))
          .pipe(Effect.mapError(mapCredentialError("write-credential")));
        yield* store.replace(updated).pipe(
          Effect.catch((error) =>
            secrets.set(stored.credentialRef, previousBytes).pipe(
              Effect.mapError(
                () =>
                  new SourceControlConnectionPersistenceError({
                    operation: "rollback-credential",
                  }),
              ),
              Effect.flatMap(() => Effect.fail(error)),
            ),
          ),
        );
        return toPublicConnection(updated);
      }),
    );

  const remove = (id: SourceControlConnectionId) =>
    transactionMutex.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* store.get(id);
        const previousBytes = yield* secrets.get(stored.credentialRef).pipe(
          Effect.mapError(mapCredentialError("read-credential")),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new SourceControlConnectionPersistenceError({ operation: "read-credential" }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        yield* secrets
          .remove(stored.credentialRef)
          .pipe(Effect.mapError(mapCredentialError("remove-credential")));
        yield* store.remove(id).pipe(
          Effect.catch((error) =>
            secrets.set(stored.credentialRef, previousBytes).pipe(
              Effect.mapError(
                () =>
                  new SourceControlConnectionPersistenceError({
                    operation: "rollback-credential",
                  }),
              ),
              Effect.flatMap(() => Effect.fail(error)),
            ),
          ),
        );
      }),
    );

  const resolveByOrigin = (origin: SourceControlConnectionUrl) =>
    Effect.gen(function* () {
      const requestedOrigin = new URL(origin).origin;
      const connections = (yield* store.list).filter(
        (connection) =>
          new URL(connection.baseUrl).origin === requestedOrigin ||
          new URL(connection.apiUrl).origin === requestedOrigin,
      );
      if (connections.length === 0) {
        return yield* new SourceControlConnectionNotFoundError({ origin });
      }
      if (connections.length > 1) {
        return yield* new SourceControlConnectionAmbiguousError({
          origin,
          connectionIds: connections.map((connection) => connection.id),
        });
      }
      return yield* resolveById(connections[0]!.id);
    });

  const resolveByRemoteUrl = (remoteUrl: string) =>
    Effect.gen(function* () {
      const parsed = parseGitRemoteUrl(remoteUrl);
      if (parsed === null) {
        return yield* new SourceControlConnectionNotFoundError({});
      }
      const matchingConnections = (yield* store.list).filter((connection) => {
        if (parsed.transport === "http") {
          const remote = new URL(remoteUrl);
          const base = new URL(connection.baseUrl);
          const basePath = base.pathname.replace(/\/+$/u, "");
          return (
            remote.origin === base.origin &&
            (basePath === "" ||
              remote.pathname === basePath ||
              remote.pathname.startsWith(`${basePath}/`))
          );
        }
        if (parsed.transport !== "ssh") return false;
        if (parsed.hostname !== connection.sshHost) return false;
        return parsed.scpStyle || parsed.port === connection.sshPort;
      });
      const connections =
        parsed.transport === "http" && matchingConnections.length > 1
          ? (() => {
              const longestBasePath = Math.max(
                ...matchingConnections.map(
                  (connection) => new URL(connection.baseUrl).pathname.replace(/\/+$/u, "").length,
                ),
              );
              return matchingConnections.filter(
                (connection) =>
                  new URL(connection.baseUrl).pathname.replace(/\/+$/u, "").length ===
                  longestBasePath,
              );
            })()
          : matchingConnections;
      if (connections.length === 0) {
        return yield* new SourceControlConnectionNotFoundError({});
      }
      if (connections.length > 1) {
        return yield* new SourceControlConnectionAmbiguousError({
          origin: connections[0]!.baseUrl,
          connectionIds: connections.map((connection) => connection.id),
        });
      }
      return yield* resolveById(connections[0]!.id);
    });

  return SourceControlConnectionService.of({
    list,
    add,
    verify,
    replaceCredential,
    remove,
    resolveById,
    resolveByOrigin,
    resolveByRemoteUrl,
  });
});

export const layer = Layer.effect(SourceControlConnectionService, make);

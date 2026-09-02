import {
  EnvironmentId,
  SourceControlConnection,
  WS_METHODS,
  type SourceControlPublishRepositoryResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createSourceControlEnvironmentAtoms } from "./sourceControl.ts";
import { vcsRefsCacheStateAtom } from "./vcsRefInvalidation.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PUBLISH_RESULT: SourceControlPublishRepositoryResult = {
  repository: {
    provider: "github",
    nameWithOwner: "t3tools/t3code",
    url: "https://github.com/t3tools/t3code",
    sshUrl: "git@github.com:t3tools/t3code.git",
  },
  remoteName: "origin",
  remoteUrl: "git@github.com:t3tools/t3code.git",
  branch: "main",
  upstreamBranch: "origin/main",
  status: "pushed",
};

const FORGEJO_CONNECTION = Schema.decodeUnknownSync(SourceControlConnection)({
  id: "00000000-0000-4000-8000-000000000001",
  provider: "forgejo",
  displayName: "Work Forgejo",
  baseUrl: "https://git.example.com",
  apiUrl: "https://git.example.com/api/v1",
  sshHost: "git.example.com",
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
  verifiedAt: DateTime.makeUnsafe("2026-08-31T00:00:00.000Z"),
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

describe("source control environment atoms", () => {
  it.effect("invalidates cached refs after successful and failed publishing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connectionState: SupervisorConnectionState = {
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        };
        let publishAttempts = 0;
        const client = {
          [WS_METHODS.sourceControlPublishRepository]: () => {
            publishAttempts += 1;
            return publishAttempts === 1
              ? Effect.succeed(PUBLISH_RESULT)
              : Effect.fail(
                  new EnvironmentRpcUnavailableError({
                    environmentId: TARGET.environmentId,
                    message: "push failed after adding the remote",
                  }),
                );
          },
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(connectionState),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
          _environmentId,
          effect,
        ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const removed = new Array<string>();
        const cache = Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeed(Option.none()),
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeed(Option.none()),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeed(Option.none()),
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeed(Option.none()),
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: (environmentId, cwd) =>
            Effect.sync(() => {
              removed.push(`${environmentId}:${cwd}`);
            }),
          clearVcsRefs: (environmentId) =>
            Effect.sync(() => {
              removed.push(`${environmentId}:*`);
            }),
          clear: () => Effect.void,
        });
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Layer.succeed(Persistence.EnvironmentCacheStore, cache),
          ),
        );
        const atoms = createSourceControlEnvironmentAtoms(runtime);
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );
        const state = vcsRefsCacheStateAtom({ environmentId: TARGET.environmentId });

        expect(registry.get(state).revision).toBe(0);
        const publishResult = yield* Effect.promise(() =>
          atoms.publishRepository.run(registry, {
            environmentId: TARGET.environmentId,
            input: {
              cwd: "/repo",
              provider: "github",
              repository: "t3tools/t3code",
              visibility: "private",
            },
          }),
        );

        expect(AsyncResult.isSuccess(publishResult)).toBe(true);
        expect(registry.get(state).revision).toBe(1);
        expect(removed).toEqual([`${TARGET.environmentId}:*`]);

        const failedPublish = yield* Effect.promise(() =>
          atoms.publishRepository.run(registry, {
            environmentId: TARGET.environmentId,
            input: {
              cwd: "/repo",
              provider: "github",
              repository: "t3tools/t3code",
              visibility: "private",
            },
          }),
        );

        expect(AsyncResult.isFailure(failedPublish)).toBe(true);
        expect(registry.get(state).revision).toBe(2);
        expect(removed).toEqual([`${TARGET.environmentId}:*`, `${TARGET.environmentId}:*`]);
      }),
    ),
  );

  it.effect("routes Forgejo connection mutations without retaining credentials in results", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connectionState: SupervisorConnectionState = {
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        };
        const calls = new Array<string>();
        let receivedToken: string | null = null;
        let receivedReplacementToken: string | null = null;
        const client = {
          [WS_METHODS.sourceControlConnectionsAdd]: (input: { token: string }) => {
            calls.push("add");
            receivedToken = input.token;
            return Effect.succeed({ connection: FORGEJO_CONNECTION });
          },
          [WS_METHODS.sourceControlConnectionsUpdate]: () => {
            calls.push("update");
            return Effect.succeed({ connection: FORGEJO_CONNECTION });
          },
          [WS_METHODS.sourceControlConnectionsVerify]: () => {
            calls.push("verify");
            return Effect.succeed({ connection: FORGEJO_CONNECTION });
          },
          [WS_METHODS.sourceControlConnectionsReplaceCredential]: (input: { token: string }) => {
            calls.push("replace");
            receivedReplacementToken = input.token;
            return Effect.succeed({ connection: FORGEJO_CONNECTION });
          },
          [WS_METHODS.sourceControlConnectionsRemove]: () => {
            calls.push("remove");
            return Effect.succeed({ id: FORGEJO_CONNECTION.id });
          },
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(connectionState),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
          _environmentId,
          effect,
        ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const cache = Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeed(Option.none()),
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeed(Option.none()),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeed(Option.none()),
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeed(Option.none()),
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        });
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Layer.succeed(Persistence.EnvironmentCacheStore, cache),
          ),
        );
        const atoms = createSourceControlEnvironmentAtoms(runtime);
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
          Effect.sync(() => value.dispose()),
        );
        const token = "sensitive-fixture-value";
        const added = yield* Effect.promise(() =>
          atoms.addConnection.run(registry, {
            environmentId: TARGET.environmentId,
            input: {
              provider: "forgejo",
              displayName: "Work Forgejo",
              baseUrl: FORGEJO_CONNECTION.baseUrl,
              token,
            },
          }),
        );
        yield* Effect.promise(() =>
          atoms.updateConnection.run(registry, {
            environmentId: TARGET.environmentId,
            input: {
              id: FORGEJO_CONNECTION.id,
              displayName: "Updated Forgejo",
              baseUrl: FORGEJO_CONNECTION.baseUrl,
              sshPort: 2222,
            },
          }),
        );
        yield* Effect.promise(() =>
          atoms.verifyConnection.run(registry, {
            environmentId: TARGET.environmentId,
            input: { id: FORGEJO_CONNECTION.id },
          }),
        );
        const replacementToken = "replacement-fixture-value";
        yield* Effect.promise(() =>
          atoms.replaceConnectionCredential.run(registry, {
            environmentId: TARGET.environmentId,
            input: { id: FORGEJO_CONNECTION.id, token: replacementToken },
          }),
        );
        yield* Effect.promise(() =>
          atoms.removeConnection.run(registry, {
            environmentId: TARGET.environmentId,
            input: { id: FORGEJO_CONNECTION.id },
          }),
        );

        expect(receivedToken).toBe(token);
        expect(receivedReplacementToken).toBe(replacementToken);
        expect(calls).toEqual(["add", "update", "verify", "replace", "remove"]);
        expect(AsyncResult.isSuccess(added)).toBe(true);
        if (AsyncResult.isSuccess(added)) {
          expect("token" in added.value.connection).toBe(false);
        }
      }),
    ),
  );
});

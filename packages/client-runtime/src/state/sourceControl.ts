import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";

export function createSourceControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  return {
    discovery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:source-control-discovery",
      tag: WS_METHODS.serverDiscoverSourceControl,
    }),
    repository: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:repository",
      tag: WS_METHODS.sourceControlLookupRepository,
    }),
    repositorySearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:repository-search",
      tag: WS_METHODS.sourceControlSearchRepositories,
    }),
    connections: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:connections",
      tag: WS_METHODS.sourceControlConnectionsList,
    }),
    addConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:add-connection",
      tag: WS_METHODS.sourceControlConnectionsAdd,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    verifyConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:verify-connection",
      tag: WS_METHODS.sourceControlConnectionsVerify,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    removeConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:remove-connection",
      tag: WS_METHODS.sourceControlConnectionsRemove,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    cloneRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:clone-repository",
      tag: WS_METHODS.sourceControlCloneRepository,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    publishRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:publish-repository",
      tag: WS_METHODS.sourceControlPublishRepository,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: (target, registry) =>
        invalidateCachedVcsRefs(registry, {
          environmentId: target.environmentId,
          cwd: target.input.cwd,
        }),
    }),
  };
}

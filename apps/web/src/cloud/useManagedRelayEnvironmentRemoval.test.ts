import { setManagedRelaySession } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "~/test/reactHookHarness";

const testState = vi.hoisted(() => ({
  deregisterCommand: Symbol("deregister-command"),
  discoveryRefreshCommand: Symbol("discovery-refresh-command"),
  environmentsState: {
    accountId: "account-1" as string | null,
    data: [] as ReadonlyArray<RelayClientEnvironmentRecord>,
    error: null as string | null,
    errorTraceId: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  removeEnvironmentCommand: vi.fn(),
  refreshDiscovery: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return {
    ...actual,
    useEffect: vi.fn(),
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("~/state/relay", () => ({
  relayEnvironmentDiscovery: { refresh: testState.discoveryRefreshCommand },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) =>
    command === testState.deregisterCommand
      ? testState.removeEnvironmentCommand
      : testState.refreshDiscovery,
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: testState.toast },
}));

vi.mock("./managedRelayState", () => ({
  deregisterManagedRelayEnvironmentCommand: testState.deregisterCommand,
  useManagedRelayEnvironments: () => testState.environmentsState,
}));

import { appAtomRegistry, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { useManagedRelayEnvironmentRemoval } from "./useManagedRelayEnvironmentRemoval";

const environment = {
  environmentId: "environment-1" as EnvironmentId,
  label: "Studio Mac",
  endpoint: {
    httpBaseUrl: "https://studio.example.com",
    wsBaseUrl: "wss://studio.example.com",
    providerKind: "cloudflare_tunnel",
  },
  linkedAt: "2026-08-12T12:00:00.000Z",
} satisfies RelayClientEnvironmentRecord;

function createDeferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setSession(accountId: string | null) {
  setManagedRelaySession(
    appAtomRegistry,
    accountId
      ? {
          accountId,
          readClerkToken: () => Promise.resolve(`${accountId}-token`),
        }
      : null,
  );
}

function renderRemovalHook() {
  hooks.beginRender();
  return useManagedRelayEnvironmentRemoval();
}

describe("managed relay environment removal", () => {
  afterEach(resetAppAtomRegistryForTests);

  beforeEach(() => {
    resetAppAtomRegistryForTests();
    hooks.reset();
    testState.environmentsState.accountId = "account-1";
    testState.environmentsState.refresh.mockReset();
    testState.removeEnvironmentCommand.mockReset();
    testState.refreshDiscovery.mockReset();
    testState.toast.mockReset();
    setSession("account-1");
  });

  it("refreshes the current account after removal succeeds", async () => {
    testState.removeEnvironmentCommand.mockResolvedValue({
      _tag: "Success",
      value: { cleanupPending: false },
    });

    await renderRemovalHook().removeEnvironment(environment);

    expect(testState.environmentsState.refresh).toHaveBeenCalledOnce();
    expect(testState.refreshDiscovery).toHaveBeenCalledOnce();
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "Environment removed from T3 Connect",
      }),
    );
  });

  it.each([
    ["sign-out", null],
    ["account switch", "account-2"],
  ])("ignores a held removal result after %s", async (_scenario, nextAccountId) => {
    const result = createDeferred<{
      readonly _tag: "Success";
      readonly value: { readonly cleanupPending: false };
    }>();
    testState.removeEnvironmentCommand.mockReturnValue(result.promise);

    const removal = renderRemovalHook().removeEnvironment(environment);
    setSession(nextAccountId);
    result.resolve({ _tag: "Success", value: { cleanupPending: false } });
    await removal;

    expect(testState.environmentsState.refresh).not.toHaveBeenCalled();
    expect(testState.refreshDiscovery).not.toHaveBeenCalled();
    expect(testState.toast).not.toHaveBeenCalled();
  });
});

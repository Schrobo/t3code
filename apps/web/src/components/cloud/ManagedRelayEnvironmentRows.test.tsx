import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "~/test/reactElementTree";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";

const testState = vi.hoisted(() => ({
  removal: {
    environmentsState: {
      accountId: "account-1" as string | null,
      data: null as ReadonlyArray<RelayClientEnvironmentRecord> | null,
      error: null as string | null,
      errorTraceId: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    confirmingEnvironmentId: null as EnvironmentId | null,
    pendingEnvironmentId: null as EnvironmentId | null,
    setConfirmingEnvironmentId: vi.fn(),
    removeEnvironment: vi.fn(),
  },
  localEnvironments: [] as Array<{
    readonly environmentId: EnvironmentId;
    readonly entry: { readonly target: { readonly _tag: string } };
  }>,
  primaryEnvironment: null as { readonly environmentId: EnvironmentId } | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("~/cloud/useManagedRelayEnvironmentRemoval", () => ({
  useManagedRelayEnvironmentRemoval: () => testState.removal,
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: testState.localEnvironments }),
  usePrimaryEnvironment: () => testState.primaryEnvironment,
}));

vi.mock("../ui/alert-dialog", async () => {
  const { createElement } = await import("react");
  const component =
    (tagName: string) =>
    ({ children, render: _render, ...props }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement(tagName, props, children);
  return {
    AlertDialog: component("section"),
    AlertDialogClose: component("button"),
    AlertDialogDescription: component("p"),
    AlertDialogFooter: component("footer"),
    AlertDialogHeader: component("header"),
    AlertDialogPopup: component("div"),
    AlertDialogTitle: component("h2"),
  };
});

vi.mock("../ui/button", async () => {
  const { createElement } = await import("react");
  return {
    Button: ({
      children,
      render: _render,
      ...props
    }: Record<string, unknown> & {
      children?: ReactNode;
    }) => createElement("button", props, children),
  };
});

vi.mock("../ui/skeleton", async () => {
  const { createElement } = await import("react");
  return {
    Skeleton: (props: Record<string, unknown>) => createElement("div", props),
  };
});

import { ManagedRelayEnvironmentRows } from "./ManagedRelayEnvironmentRows";

const environment: RelayClientEnvironmentRecord = {
  environmentId: "environment-1" as EnvironmentId,
  label: "Studio Mac",
  endpoint: {
    httpBaseUrl: "https://studio.example.com",
    wsBaseUrl: "wss://studio.example.com",
    providerKind: "cloudflare_tunnel",
  },
  linkedAt: "2026-08-12T12:00:00.000Z",
};

function renderRows(): ReactElement | null {
  hooks.beginRender();
  return ManagedRelayEnvironmentRows() as ReactElement | null;
}

function renderMarkup(): string {
  return renderToStaticMarkup(renderRows());
}

function findElement(children: ReactNode, text: string) {
  return visitElements(children, (element) => element.props.children === text);
}

describe("managed relay environment rows", () => {
  beforeEach(() => {
    hooks.reset();
    testState.removal.environmentsState.accountId = "account-1";
    testState.removal.environmentsState.data = null;
    testState.removal.environmentsState.error = null;
    testState.removal.environmentsState.errorTraceId = null;
    testState.removal.environmentsState.isPending = false;
    testState.removal.environmentsState.refresh.mockReset();
    testState.removal.confirmingEnvironmentId = null;
    testState.removal.pendingEnvironmentId = null;
    testState.removal.setConfirmingEnvironmentId.mockReset();
    testState.removal.setConfirmingEnvironmentId.mockImplementation(
      (environmentId: EnvironmentId | null) => {
        testState.removal.confirmingEnvironmentId = environmentId;
      },
    );
    testState.removal.removeEnvironment.mockReset();
    testState.localEnvironments = [];
    testState.primaryEnvironment = null;
  });

  it("uses static row placeholders during the initial load", () => {
    const markup = renderMarkup();

    expect(markup).toContain('aria-label="Loading account environments"');
    expect(markup.match(/after:hidden/g)).toHaveLength(3);
    expect(markup).not.toContain("Loading...");
    expect(markup).not.toContain("animate-skeleton");
  });

  it("keeps cached rows visible when a background refresh fails", () => {
    testState.removal.environmentsState.data = [environment];
    testState.removal.environmentsState.error = "Relay request failed";

    const markup = renderMarkup();

    expect(markup).toContain("Could not load account environments");
    expect(markup).toContain("Relay request failed");
    expect(markup).toContain("Studio Mac");
    expect(markup).toContain("Remove from T3 Connect");
  });

  it("keeps the selected environment and warning through the dialog exit", () => {
    testState.removal.environmentsState.data = [environment];
    testState.localEnvironments = [
      {
        environmentId: environment.environmentId,
        entry: { target: { _tag: "RelayConnectionTarget" } },
      },
    ];

    const firstRender = renderRows();
    const removeButton = findElement(firstRender, "Remove from T3 Connect");
    (removeButton?.props.onClick as (() => void) | undefined)?.();

    expect(renderMarkup()).toContain("Remove Studio Mac from T3 Connect?");
    expect(renderMarkup()).toContain("The connection can close after removal.");

    testState.removal.environmentsState.accountId = "account-2";
    testState.removal.environmentsState.data = [];
    const closingRender = renderRows();
    const dialog = visitElements(
      closingRender,
      (element) => typeof element.props.onOpenChangeComplete === "function",
    );

    expect(dialog?.props.open).toBe(false);
    expect(renderToStaticMarkup(closingRender)).toContain("Remove Studio Mac from T3 Connect?");

    (dialog?.props.onOpenChangeComplete as ((open: boolean) => void) | undefined)?.(false);

    const closedMarkup = renderMarkup();
    expect(closedMarkup).not.toContain("Studio Mac");
    expect(closedMarkup).not.toContain("The connection can close after removal.");
  });

  it.each([
    [environment, "Removing..."],
    [{ ...environment, cleanupPending: true }, "Retrying cleanup..."],
  ])("shows a specific static pending label", (selectedEnvironment, pendingLabel) => {
    testState.removal.environmentsState.data = [selectedEnvironment];

    const firstRender = renderRows();
    const actionLabel = selectedEnvironment.cleanupPending
      ? "Retry cleanup"
      : "Remove from T3 Connect";
    const removeButton = findElement(firstRender, actionLabel);
    (removeButton?.props.onClick as (() => void) | undefined)?.();
    testState.removal.pendingEnvironmentId = selectedEnvironment.environmentId;

    const pendingRender = renderRows();
    const pendingButton = findElement(pendingRender, pendingLabel);
    const dialog = visitElements(
      pendingRender,
      (element) => typeof element.props.onOpenChangeComplete === "function",
    );
    testState.removal.setConfirmingEnvironmentId.mockClear();
    (dialog?.props.onOpenChange as ((open: boolean) => void) | undefined)?.(false);

    expect(pendingButton?.props.disabled).toBe(true);
    expect(pendingButton?.props["aria-busy"]).toBe(true);
    expect(pendingButton?.props.className).toContain("min-w-48");
    expect(testState.removal.setConfirmingEnvironmentId).not.toHaveBeenCalled();
  });
});

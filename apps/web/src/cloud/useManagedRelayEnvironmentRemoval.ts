import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { useEffect, useRef, useState } from "react";

import { relayEnvironmentDiscovery } from "~/state/relay";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  deregisterManagedRelayEnvironmentCommand,
  useManagedRelayEnvironments,
} from "./managedRelayState";

export function useManagedRelayEnvironmentRemoval() {
  const environmentsState = useManagedRelayEnvironments();
  const removeEnvironmentCommand = useAtomCommand(deregisterManagedRelayEnvironmentCommand, {
    reportFailure: false,
  });
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const pendingRef = useRef(false);
  const [confirmingEnvironmentId, setConfirmingEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const [pendingEnvironmentId, setPendingEnvironmentId] = useState<EnvironmentId | null>(null);
  useEffect(() => {
    setConfirmingEnvironmentId(null);
  }, [environmentsState.accountId]);

  const removeEnvironment = async (environment: RelayClientEnvironmentRecord) => {
    const accountId = environmentsState.accountId;
    if (!accountId || pendingRef.current) return;

    pendingRef.current = true;
    setPendingEnvironmentId(environment.environmentId);
    const result = await removeEnvironmentCommand({
      accountId,
      environmentId: environment.environmentId,
    });
    pendingRef.current = false;
    setPendingEnvironmentId(null);

    if (appAtomRegistry.get(managedRelaySessionAtom)?.accountId !== accountId) return;
    if (result._tag === "Success") {
      setConfirmingEnvironmentId(null);
      environmentsState.refresh();
      void refreshDiscovery();
      toastManager.add(
        result.value.cleanupPending
          ? {
              type: "warning",
              title: "Environment removed, cleanup pending",
              description: "Removed from your account. Tunnel cleanup is pending.",
            }
          : {
              type: "success",
              title: "Environment removed from T3 Connect",
              description: `${environment.label} is no longer registered to this account.`,
            },
      );
      return;
    }
    if (isAtomCommandInterrupted(result)) return;

    const cause = squashAtomCommandFailure(result);
    const message = cause instanceof Error ? cause.message : "Could not remove the environment.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not remove account environment", {
      environmentId: environment.environmentId,
      message,
      traceId,
      cause,
    });
    toastManager.add({
      type: "error",
      title: environment.cleanupPending
        ? "Could not finish cleanup"
        : "Could not remove environment",
      description: message,
      data: traceId
        ? {
            secondaryActionProps: {
              children: "Copy trace ID",
              onClick: () => void navigator.clipboard?.writeText(traceId),
            },
          }
        : undefined,
    });
  };

  return {
    environmentsState,
    confirmingEnvironmentId,
    pendingEnvironmentId,
    setConfirmingEnvironmentId,
    removeEnvironment,
  };
}

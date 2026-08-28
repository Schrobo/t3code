import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { useState } from "react";

import { useManagedRelayEnvironmentRemoval } from "~/cloud/useManagedRelayEnvironmentRemoval";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";

interface DialogSelection {
  readonly accountId: string;
  readonly environment: RelayClientEnvironmentRecord;
  readonly connectionWarning: string | null;
}

function endpointLabel(environment: RelayClientEnvironmentRecord): string {
  return environment.endpoint.providerKind === "cloudflare_tunnel"
    ? "Managed tunnel"
    : "Activity publishing only";
}

function ManagedRelayEnvironmentRowsSkeleton() {
  return (
    <div className={ITEM_ROW_CLASSNAME} role="status" aria-label="Loading account environments">
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-32 rounded-full after:hidden" />
          <Skeleton className="h-3 w-20 rounded-full after:hidden" />
        </div>
        <Skeleton className="h-7 w-48 rounded-md after:hidden" />
      </div>
    </div>
  );
}

function ManagedRelayEnvironmentError({
  error,
  refresh,
}: {
  readonly error: string;
  readonly refresh: () => void;
}) {
  return (
    <div className={ITEM_ROW_CLASSNAME} role="alert">
      <p className="text-sm font-medium text-destructive">Could not load account environments</p>
      <p className="mt-1 text-xs text-muted-foreground">{error}</p>
      <Button className="mt-3" size="sm" variant="outline" onClick={refresh}>
        Try again
      </Button>
    </div>
  );
}

export function ManagedRelayEnvironmentRows() {
  const removal = useManagedRelayEnvironmentRemoval();
  const { environmentsState, pendingEnvironmentId } = removal;
  const { environments: localEnvironments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const [dialogSelection, setDialogSelection] = useState<DialogSelection | null>(null);

  const accountId = environmentsState.accountId;
  if (!accountId) return null;

  const environments = environmentsState.data ?? [];
  const selectedEnvironment = dialogSelection?.environment ?? null;
  const dialogOpen =
    dialogSelection?.accountId === accountId &&
    removal.confirmingEnvironmentId === selectedEnvironment?.environmentId;
  const mutationPending = pendingEnvironmentId !== null;
  return (
    <>
      {environmentsState.data === null && !environmentsState.error ? (
        <ManagedRelayEnvironmentRowsSkeleton />
      ) : null}

      {environmentsState.error ? (
        <ManagedRelayEnvironmentError
          error={environmentsState.error}
          refresh={environmentsState.refresh}
        />
      ) : null}

      {environmentsState.data !== null && environments.length === 0 && !environmentsState.error ? (
        <p className={`${ITEM_ROW_CLASSNAME} text-sm text-muted-foreground`}>
          No environments are registered to this account.
        </p>
      ) : null}

      {environmentsState.data !== null
        ? environments.map((environment) => (
            <div key={environment.environmentId} className={ITEM_ROW_CLASSNAME}>
              <div className={ITEM_ROW_INNER_CLASSNAME}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{environment.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {environment.cleanupPending ? "Cleanup pending" : endpointLabel(environment)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={mutationPending}
                  onClick={() => {
                    const selectedLocalEnvironment = localEnvironments.find(
                      (localEnvironment) =>
                        localEnvironment.environmentId === environment.environmentId,
                    );
                    const connectionWarning =
                      selectedLocalEnvironment?.entry.target._tag === "RelayConnectionTarget"
                        ? " This client is using T3 Connect for this environment. The connection can close after removal."
                        : environment.environmentId === primaryEnvironment?.environmentId
                          ? " This is the current environment. Its local connection and session are not removed."
                          : null;
                    setDialogSelection({
                      accountId,
                      environment,
                      connectionWarning,
                    });
                    removal.setConfirmingEnvironmentId(environment.environmentId);
                  }}
                >
                  {environment.cleanupPending ? "Retry cleanup" : "Remove from T3 Connect"}
                </Button>
              </div>
            </div>
          ))
        : null}

      <AlertDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open && !mutationPending) removal.setConfirmingEnvironmentId(null);
        }}
        onOpenChangeComplete={(open) => {
          if (!open) setDialogSelection(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selectedEnvironment?.cleanupPending
                ? "Retry T3 Connect cleanup?"
                : `Remove ${selectedEnvironment?.label ?? "environment"} from T3 Connect?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedEnvironment?.cleanupPending
                ? "This environment is already removed from your account. Stop the running host before retrying tunnel cleanup."
                : "This removes the environment from your account and stops activity publishing. Tunnel cleanup can require the running host to stop. Files, agents, and direct connections are not changed."}
              {dialogSelection?.connectionWarning}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button variant="outline" disabled={mutationPending} />}
              disabled={mutationPending}
            >
              Cancel
            </AlertDialogClose>
            <Button
              className="min-w-48"
              variant="destructive"
              disabled={mutationPending || selectedEnvironment === null}
              aria-busy={mutationPending}
              onClick={() => {
                if (dialogSelection?.accountId === accountId && selectedEnvironment) {
                  void removal.removeEnvironment(selectedEnvironment);
                }
              }}
            >
              {mutationPending
                ? selectedEnvironment?.cleanupPending
                  ? "Retrying cleanup..."
                  : "Removing..."
                : selectedEnvironment?.cleanupPending
                  ? "Retry cleanup"
                  : "Remove from T3 Connect"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

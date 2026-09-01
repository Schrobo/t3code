"use client";

import {
  SourceControlConnectionAddInput,
  type EnvironmentId,
  type SourceControlConnection,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { CheckCircle2Icon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { sourceControlEnvironment } from "../../state/sourceControl";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ForgejoIcon } from "../Icons";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { SettingsSection } from "./settingsLayout";

interface ForgejoConnectionDraft {
  readonly displayName: string;
  readonly baseUrl: string;
  readonly apiUrl: string;
  readonly token: string;
}

type ForgejoConnectionDraftField = keyof ForgejoConnectionDraft;
type ForgejoConnectionDraftErrors = Partial<Record<ForgejoConnectionDraftField, string>>;

const EMPTY_DRAFT: ForgejoConnectionDraft = {
  displayName: "",
  baseUrl: "",
  apiUrl: "",
  token: "",
};

const decodeConnectionInput = Schema.decodeUnknownSync(SourceControlConnectionAddInput);

export function validateForgejoConnectionDraft(
  draft: ForgejoConnectionDraft,
): ForgejoConnectionDraftErrors {
  const errors: ForgejoConnectionDraftErrors = {};
  if (draft.displayName.trim().length === 0) errors.displayName = "Enter a connection name.";
  if (draft.baseUrl.trim().length === 0) {
    errors.baseUrl = "Enter the Forgejo base URL.";
  } else {
    try {
      const url = new URL(draft.baseUrl.trim());
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
        errors.baseUrl = "Use HTTPS for remote Forgejo instances.";
      }
    } catch {
      errors.baseUrl = "Enter a valid URL, for example https://forge.example.com.";
    }
  }
  if (draft.apiUrl.trim().length > 0) {
    try {
      const url = new URL(draft.apiUrl.trim());
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
        errors.apiUrl = "Use HTTPS for remote Forgejo API URLs.";
      }
    } catch {
      errors.apiUrl = "Enter a valid API URL or leave this field empty.";
    }
  }
  if (draft.token.trim().length === 0) errors.token = "Enter a personal access token.";
  return errors;
}

export function formatForgejoConnectionError(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "SourceControlConnectionAuthenticationError":
        return "Forgejo rejected the token. Check its permissions and try again.";
      case "SourceControlConnectionAlreadyExistsError":
        return "This Forgejo connection already exists.";
      case "SourceControlConnectionIncompatibleVersionError":
        return "This Forgejo version is not supported.";
      case "SourceControlConnectionInvalidUrlError":
        return "Forgejo could not use that URL. Check the base and API URLs.";
      case "SourceControlConnectionNotFoundError":
        return "The Forgejo connection no longer exists. Refresh the list.";
    }
  }
  return "Forgejo could not complete the request. Check the connection and try again.";
}

function ConnectionRow(props: {
  readonly connection: SourceControlConnection;
  readonly busy: boolean;
  readonly onVerify: () => void;
  readonly onRemove: () => void;
}) {
  const { connection } = props;
  return (
    <div className="flex flex-col gap-3 rounded-xl px-3 py-3 sm:flex-row sm:items-center sm:px-4">
      <ForgejoIcon className="size-5 shrink-0 text-foreground/80" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{connection.displayName}</span>
          <Badge variant="success" size="sm">
            Credential stored
          </Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {connection.baseUrl} · {connection.identity.login} · Forgejo {connection.serverVersion} ·
          verified {DateTime.toDate(connection.verifiedAt).toLocaleString()}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="compact" variant="outline" disabled={props.busy} onClick={props.onVerify}>
          <RefreshCwIcon aria-hidden />
          Verify
        </Button>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.busy}
          aria-label={`Remove ${connection.displayName}`}
          onClick={props.onRemove}
        >
          <Trash2Icon aria-hidden />
        </Button>
      </div>
    </div>
  );
}

export function ForgejoConnectionsSettings(props: {
  readonly environmentId: EnvironmentId | null;
}) {
  const query = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : sourceControlEnvironment.connections({ environmentId: props.environmentId, input: {} }),
  );
  const addConnection = useAtomCommand(sourceControlEnvironment.addConnection, {
    reportFailure: false,
  });
  const verifyConnection = useAtomCommand(sourceControlEnvironment.verifyConnection, {
    reportFailure: false,
  });
  const removeConnection = useAtomCommand(sourceControlEnvironment.removeConnection, {
    reportFailure: false,
  });
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [errors, setErrors] = useState<ForgejoConnectionDraftErrors>({});
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SourceControlConnection | null>(null);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const apiUrlRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const connections = (query.data?.connections ?? []).filter(
    (connection) => connection.provider === "forgejo",
  );

  const updateDraft = (field: ForgejoConnectionDraftField, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const closeAddDialog = () => {
    setAddOpen(false);
    setDraft(EMPTY_DRAFT);
    setErrors({});
    setRequestError(null);
  };

  const submit = async () => {
    if (props.environmentId === null || isAdding) return;
    const nextErrors = validateForgejoConnectionDraft(draft);
    setErrors(nextErrors);
    const firstError = (["displayName", "baseUrl", "apiUrl", "token"] as const).find(
      (field) => nextErrors[field],
    );
    if (firstError) {
      ({ displayName: displayNameRef, baseUrl: baseUrlRef, apiUrl: apiUrlRef, token: tokenRef })[
        firstError
      ].current?.focus();
      return;
    }

    let input: SourceControlConnectionAddInput;
    try {
      input = decodeConnectionInput({
        provider: "forgejo",
        displayName: draft.displayName.trim(),
        baseUrl: draft.baseUrl.trim(),
        ...(draft.apiUrl.trim() ? { apiUrl: draft.apiUrl.trim() } : {}),
        token: draft.token,
      });
    } catch {
      setRequestError("Check the connection details and try again.");
      return;
    }

    setRequestError(null);
    setDraft((current) => ({ ...current, token: "" }));
    setIsAdding(true);
    const result = await addConnection({ environmentId: props.environmentId, input });
    setIsAdding(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setRequestError(formatForgejoConnectionError(squashAtomCommandFailure(result)));
      }
      return;
    }
    closeAddDialog();
    query.refresh();
  };

  const verify = async (connection: SourceControlConnection) => {
    if (props.environmentId === null) return;
    setRequestError(null);
    setBusyConnectionId(connection.id);
    const result = await verifyConnection({
      environmentId: props.environmentId,
      input: { id: connection.id },
    });
    setBusyConnectionId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setRequestError(formatForgejoConnectionError(squashAtomCommandFailure(result)));
      return;
    }
    query.refresh();
  };

  const remove = async () => {
    if (props.environmentId === null || removeTarget === null) return;
    setRequestError(null);
    setBusyConnectionId(removeTarget.id);
    const result = await removeConnection({
      environmentId: props.environmentId,
      input: { id: removeTarget.id },
    });
    setBusyConnectionId(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setRequestError(formatForgejoConnectionError(squashAtomCommandFailure(result)));
      }
      return;
    }
    setRemoveTarget(null);
    query.refresh();
  };

  return (
    <>
      <SettingsSection
        title="Forgejo connections"
        headerAction={
          <Button
            size="compact"
            variant="outline"
            onClick={() => setAddOpen(true)}
            disabled={props.environmentId === null}
          >
            <PlusIcon aria-hidden />
            Add connection
          </Button>
        }
      >
        {query.isPending && query.data === null ? (
          <div className="space-y-3 p-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : connections.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl px-3 py-4 sm:px-4">
            <ForgejoIcon className="size-5 text-muted-foreground" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium">No Forgejo connections</p>
              <p className="text-xs text-muted-foreground">
                Add each Forgejo instance separately. Tokens stay in the server credential store.
              </p>
            </div>
          </div>
        ) : (
          connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              busy={busyConnectionId === connection.id}
              onVerify={() => void verify(connection)}
              onRemove={() => setRemoveTarget(connection)}
            />
          ))
        )}
        {query.error || requestError ? (
          <p role="alert" className="px-4 pb-3 text-xs text-destructive">
            {requestError ?? "Forgejo connections could not be loaded. Refresh and try again."}
          </p>
        ) : null}
      </SettingsSection>

      <Dialog open={addOpen} onOpenChange={(open) => (open ? setAddOpen(true) : closeAddDialog())}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Add Forgejo connection</DialogTitle>
            <DialogDescription>
              Connect one Forgejo instance. The server verifies the token before saving it securely.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogPanel className="grid gap-4">
              {(
                [
                  ["displayName", "Connection name", "Work Forgejo", "text", "off", displayNameRef],
                  ["baseUrl", "Base URL", "https://forge.example.com", "url", "url", baseUrlRef],
                  [
                    "apiUrl",
                    "API URL (optional)",
                    "Derived from the base URL",
                    "url",
                    "url",
                    apiUrlRef,
                  ],
                  [
                    "token",
                    "Personal access token",
                    "Required",
                    "password",
                    "current-password",
                    tokenRef,
                  ],
                ] as const
              ).map(([field, label, placeholder, type, autoComplete, ref]) => {
                const errorId = `forgejo-${field}-error`;
                return (
                  <label key={field} className="grid gap-2">
                    <span className="text-xs font-medium">{label}</span>
                    <Input
                      nativeInput
                      ref={ref}
                      type={type}
                      autoComplete={autoComplete}
                      value={draft[field]}
                      placeholder={placeholder}
                      aria-invalid={Boolean(errors[field]) || undefined}
                      aria-describedby={errors[field] ? errorId : undefined}
                      onChange={(event) => updateDraft(field, event.target.value)}
                    />
                    {errors[field] ? (
                      <span id={errorId} className="text-xs text-destructive">
                        {errors[field]}
                      </span>
                    ) : null}
                  </label>
                );
              })}
              {requestError ? (
                <p role="alert" className="text-xs text-destructive">
                  {requestError}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button type="submit" disabled={isAdding}>
                <CheckCircle2Icon aria-hidden />
                {isAdding ? "Verifying…" : "Verify and add"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Forgejo connection?</AlertDialogTitle>
            <AlertDialogDescription>
              T3 Code will remove {removeTarget?.displayName ?? "this connection"} and its stored
              credential. Existing Git remotes are unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={removeTarget !== null && busyConnectionId === removeTarget.id}
              onClick={() => void remove()}
            >
              Remove connection
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

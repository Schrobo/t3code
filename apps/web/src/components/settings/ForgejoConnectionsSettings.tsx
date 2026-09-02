"use client";

import {
  SourceControlConnectionAddInput,
  SourceControlConnectionUpdateInput,
  type EnvironmentId,
  type SourceControlConnection,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  KeyRoundIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "../../lib/utils";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
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

interface ForgejoConnectionDraft {
  readonly displayName: string;
  readonly baseUrl: string;
  readonly apiUrl: string;
  readonly sshHost: string;
  readonly sshPort: string;
  readonly token: string;
}

type ForgejoConnectionDraftField = keyof ForgejoConnectionDraft;
type ForgejoConnectionDraftErrors = Partial<Record<ForgejoConnectionDraftField, string>>;

const EMPTY_DRAFT: ForgejoConnectionDraft = {
  displayName: "",
  baseUrl: "",
  apiUrl: "",
  sshHost: "",
  sshPort: "22",
  token: "",
};

const decodeConnectionInput = Schema.decodeUnknownSync(SourceControlConnectionAddInput);
const decodeConnectionUpdateInput = Schema.decodeUnknownSync(SourceControlConnectionUpdateInput);

export function validateForgejoConnectionDraft(
  draft: ForgejoConnectionDraft,
  options: { readonly requireToken?: boolean } = {},
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
  if (draft.sshHost.trim().length > 0) {
    try {
      const url = new URL(`ssh://${draft.sshHost.trim()}`);
      if (url.hostname !== draft.sshHost.trim().toLowerCase() || url.port || url.pathname !== "") {
        errors.sshHost = "Enter a hostname without a protocol, path, or port.";
      }
    } catch {
      errors.sshHost = "Enter a valid SSH hostname or leave this field empty.";
    }
  }
  const sshPort = Number(draft.sshPort);
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65_535) {
    errors.sshPort = "Enter an SSH port from 1 to 65535.";
  }
  if (options.requireToken !== false && draft.token.trim().length === 0) {
    errors.token = "Enter a personal access token.";
  }
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
  readonly onEdit: () => void;
  readonly onReplaceCredential: () => void;
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
        <p className="truncate text-xs text-muted-foreground">
          SSH: {connection.sshHost}:{connection.sshPort}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="compact" variant="ghost-muted" disabled={props.busy} onClick={props.onEdit}>
          <PencilIcon aria-hidden />
          Edit connection
        </Button>
        <Button
          size="compact"
          variant="ghost-muted"
          disabled={props.busy}
          onClick={props.onReplaceCredential}
        >
          <KeyRoundIcon aria-hidden />
          Update credential
        </Button>
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
  readonly addOpen: boolean;
  readonly onAddOpenChange: (open: boolean) => void;
}) {
  const query = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : sourceControlEnvironment.connections({ environmentId: props.environmentId, input: {} }),
  );
  const addConnection = useAtomCommand(sourceControlEnvironment.addConnection, {
    reportFailure: false,
  });
  const updateConnection = useAtomCommand(sourceControlEnvironment.updateConnection, {
    reportFailure: false,
  });
  const verifyConnection = useAtomCommand(sourceControlEnvironment.verifyConnection, {
    reportFailure: false,
  });
  const replaceConnectionCredential = useAtomCommand(
    sourceControlEnvironment.replaceConnectionCredential,
    { reportFailure: false },
  );
  const removeConnection = useAtomCommand(sourceControlEnvironment.removeConnection, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [errors, setErrors] = useState<ForgejoConnectionDraftErrors>({});
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SourceControlConnection | null>(null);
  const [credentialTarget, setCredentialTarget] = useState<SourceControlConnection | null>(null);
  const [editTarget, setEditTarget] = useState<SourceControlConnection | null>(null);
  const [editDraft, setEditDraft] = useState(EMPTY_DRAFT);
  const [editErrors, setEditErrors] = useState<ForgejoConnectionDraftErrors>({});
  const [editRequestError, setEditRequestError] = useState<string | null>(null);
  const [replacementToken, setReplacementToken] = useState("");
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const apiUrlRef = useRef<HTMLInputElement>(null);
  const sshHostRef = useRef<HTMLInputElement>(null);
  const sshPortRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const replacementTokenRef = useRef<HTMLInputElement>(null);
  const editDisplayNameRef = useRef<HTMLInputElement>(null);
  const editBaseUrlRef = useRef<HTMLInputElement>(null);
  const editApiUrlRef = useRef<HTMLInputElement>(null);
  const editSshHostRef = useRef<HTMLInputElement>(null);
  const editSshPortRef = useRef<HTMLInputElement>(null);
  const connections = (query.data?.connections ?? []).filter(
    (connection) => connection.provider === "forgejo",
  );

  const updateDraft = (field: ForgejoConnectionDraftField, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const closeAddDialog = () => {
    props.onAddOpenChange(false);
    setDraft(EMPTY_DRAFT);
    setAdvancedOpen(false);
    setErrors({});
    setRequestError(null);
  };

  const submit = async () => {
    if (props.environmentId === null || isAdding) return;
    const nextErrors = validateForgejoConnectionDraft(draft);
    setErrors(nextErrors);
    const firstError = (
      ["displayName", "baseUrl", "apiUrl", "sshHost", "sshPort", "token"] as const
    ).find((field) => nextErrors[field]);
    if (firstError) {
      const firstErrorRef = {
        displayName: displayNameRef,
        baseUrl: baseUrlRef,
        apiUrl: apiUrlRef,
        sshHost: sshHostRef,
        sshPort: sshPortRef,
        token: tokenRef,
      }[firstError];
      if (firstError === "sshHost" || firstError === "sshPort") {
        setAdvancedOpen(true);
        queueMicrotask(() => firstErrorRef.current?.focus());
      } else {
        firstErrorRef.current?.focus();
      }
      return;
    }

    let input: SourceControlConnectionAddInput;
    try {
      input = decodeConnectionInput({
        provider: "forgejo",
        displayName: draft.displayName.trim(),
        baseUrl: draft.baseUrl.trim(),
        ...(draft.apiUrl.trim() ? { apiUrl: draft.apiUrl.trim() } : {}),
        ...(draft.sshHost.trim() ? { sshHost: draft.sshHost.trim() } : {}),
        sshPort: Number(draft.sshPort),
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

  const closeCredentialDialog = () => {
    setCredentialTarget(null);
    setReplacementToken("");
    setCredentialError(null);
  };

  const openEditDialog = (connection: SourceControlConnection) => {
    setEditTarget(connection);
    setEditDraft({
      displayName: connection.displayName,
      baseUrl: connection.baseUrl,
      apiUrl: connection.apiUrl,
      sshHost: connection.sshHost,
      sshPort: String(connection.sshPort),
      token: "",
    });
    setEditErrors({});
    setEditRequestError(null);
  };

  const closeEditDialog = () => {
    setEditTarget(null);
    setEditDraft(EMPTY_DRAFT);
    setEditErrors({});
    setEditRequestError(null);
  };

  const updateEditDraft = (field: ForgejoConnectionDraftField, value: string) => {
    setEditDraft((current) => ({ ...current, [field]: value }));
    setEditErrors((current) => ({ ...current, [field]: undefined }));
  };

  const updateMetadata = async () => {
    if (props.environmentId === null || editTarget === null) return;
    const nextErrors = validateForgejoConnectionDraft(editDraft, { requireToken: false });
    setEditErrors(nextErrors);
    const firstError = (["displayName", "baseUrl", "apiUrl", "sshHost", "sshPort"] as const).find(
      (field) => nextErrors[field],
    );
    if (firstError) {
      const firstErrorRef = {
        displayName: editDisplayNameRef,
        baseUrl: editBaseUrlRef,
        apiUrl: editApiUrlRef,
        sshHost: editSshHostRef,
        sshPort: editSshPortRef,
      }[firstError];
      firstErrorRef.current?.focus();
      return;
    }

    let input: SourceControlConnectionUpdateInput;
    try {
      input = decodeConnectionUpdateInput({
        id: editTarget.id,
        displayName: editDraft.displayName.trim(),
        baseUrl: editDraft.baseUrl.trim(),
        ...(editDraft.apiUrl.trim() ? { apiUrl: editDraft.apiUrl.trim() } : {}),
        ...(editDraft.sshHost.trim() ? { sshHost: editDraft.sshHost.trim() } : {}),
        sshPort: Number(editDraft.sshPort),
      });
    } catch {
      setEditRequestError("Check the connection details and try again.");
      return;
    }

    setEditRequestError(null);
    setBusyConnectionId(editTarget.id);
    const result = await updateConnection({ environmentId: props.environmentId, input });
    setBusyConnectionId(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setEditRequestError(formatForgejoConnectionError(squashAtomCommandFailure(result)));
      }
      return;
    }
    closeEditDialog();
    query.refresh();
  };

  const replaceCredential = async () => {
    if (props.environmentId === null || credentialTarget === null) return;
    if (replacementToken.trim().length === 0) {
      setCredentialError("Enter a personal access token.");
      replacementTokenRef.current?.focus();
      return;
    }
    const token = replacementToken;
    setReplacementToken("");
    setCredentialError(null);
    setBusyConnectionId(credentialTarget.id);
    const result = await replaceConnectionCredential({
      environmentId: props.environmentId,
      input: { id: credentialTarget.id, token },
    });
    setBusyConnectionId(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setCredentialError(formatForgejoConnectionError(squashAtomCommandFailure(result)));
      }
      return;
    }
    closeCredentialDialog();
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
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <div className="rounded-xl transition-colors hover:bg-muted/20">
          <div className="flex items-center gap-3 px-3 py-3 sm:px-4">
            <ForgejoIcon className="size-5 shrink-0 text-foreground/80" aria-hidden />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Forgejo</span>
                <Badge variant={connections.length > 0 ? "success" : "outline"} size="sm">
                  {connections.length} {connections.length === 1 ? "connection" : "connections"}
                </Badge>
              </div>
              <p className="text-[13px] leading-[1.45] text-muted-foreground/80">
                Connect self-hosted Forgejo instances with server-stored credentials.
              </p>
            </div>
            <CollapsibleTrigger
              render={
                <Button
                  size="compact"
                  variant="ghost-muted"
                  aria-label="Toggle Forgejo connections"
                />
              }
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
                aria-hidden
              />
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div className="px-3 pb-4 pt-1 sm:px-4">
              {query.isPending && query.data === null ? (
                <div className="space-y-3">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : connections.length === 0 ? (
                <div className="rounded-lg bg-muted/20 px-3 py-4">
                  <p className="text-sm font-medium">No Forgejo connections</p>
                  <p className="text-xs text-muted-foreground">
                    Add each Forgejo instance separately. Tokens stay in the server credential
                    store.
                  </p>
                </div>
              ) : (
                connections.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    busy={busyConnectionId === connection.id}
                    onEdit={() => openEditDialog(connection)}
                    onReplaceCredential={() => {
                      setCredentialError(null);
                      setReplacementToken("");
                      setCredentialTarget(connection);
                    }}
                    onVerify={() => void verify(connection)}
                    onRemove={() => setRemoveTarget(connection)}
                  />
                ))
              )}
              {query.error || requestError ? (
                <p role="alert" className="px-3 pb-2 text-xs text-destructive">
                  {requestError ??
                    "Forgejo connections could not be loaded. Refresh and try again."}
                </p>
              ) : null}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      <Dialog
        open={props.addOpen}
        onOpenChange={(open) => (open ? props.onAddOpenChange(true) : closeAddDialog())}
      >
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
              <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <CollapsibleTrigger className="flex min-h-8 w-full items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                  <ChevronDownIcon
                    className={cn("size-3.5 transition-transform", advancedOpen && "rotate-180")}
                    aria-hidden
                  />
                  Advanced SSH settings
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="grid gap-4 pt-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                    <label className="grid gap-2">
                      <span className="text-xs font-medium">SSH host (optional)</span>
                      <Input
                        nativeInput
                        ref={sshHostRef}
                        type="text"
                        autoComplete="off"
                        value={draft.sshHost}
                        placeholder="Derived from the base URL"
                        aria-invalid={Boolean(errors.sshHost) || undefined}
                        aria-describedby={errors.sshHost ? "forgejo-sshHost-error" : undefined}
                        onChange={(event) => updateDraft("sshHost", event.target.value)}
                      />
                      {errors.sshHost ? (
                        <span id="forgejo-sshHost-error" className="text-xs text-destructive">
                          {errors.sshHost}
                        </span>
                      ) : null}
                    </label>
                    <label className="grid gap-2">
                      <span className="text-xs font-medium">SSH port</span>
                      <Input
                        nativeInput
                        ref={sshPortRef}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={65_535}
                        value={draft.sshPort}
                        aria-invalid={Boolean(errors.sshPort) || undefined}
                        aria-describedby={errors.sshPort ? "forgejo-sshPort-error" : undefined}
                        onChange={(event) => updateDraft("sshPort", event.target.value)}
                      />
                      {errors.sshPort ? (
                        <span id="forgejo-sshPort-error" className="text-xs text-destructive">
                          {errors.sshPort}
                        </span>
                      ) : null}
                    </label>
                  </div>
                  <p className="pt-2 text-xs text-muted-foreground">
                    Change port 22 when Forgejo uses a nonstandard SSH port such as 2222.
                  </p>
                </CollapsibleContent>
              </Collapsible>
              <label className="grid gap-2">
                <span className="text-xs font-medium">Personal access token</span>
                <Input
                  nativeInput
                  ref={tokenRef}
                  type="password"
                  autoComplete="current-password"
                  value={draft.token}
                  placeholder="Required"
                  aria-invalid={Boolean(errors.token) || undefined}
                  aria-describedby={errors.token ? "forgejo-token-error" : undefined}
                  onChange={(event) => updateDraft("token", event.target.value)}
                />
                {errors.token ? (
                  <span id="forgejo-token-error" className="text-xs text-destructive">
                    {errors.token}
                  </span>
                ) : null}
              </label>
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

      <Dialog open={editTarget !== null} onOpenChange={(open) => !open && closeEditDialog()}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Edit Forgejo connection</DialogTitle>
            <DialogDescription>
              Update routing and instance details. T3 Code verifies them with the stored credential
              before saving.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void updateMetadata();
            }}
          >
            <DialogPanel className="grid gap-4">
              {(
                [
                  [
                    "displayName",
                    "Connection name",
                    "Work Forgejo",
                    "text",
                    "off",
                    editDisplayNameRef,
                  ],
                  [
                    "baseUrl",
                    "Base URL",
                    "https://forge.example.com",
                    "url",
                    "url",
                    editBaseUrlRef,
                  ],
                  [
                    "apiUrl",
                    "API URL (optional)",
                    "Derived from the base URL",
                    "url",
                    "url",
                    editApiUrlRef,
                  ],
                ] as const
              ).map(([field, label, placeholder, type, autoComplete, ref]) => {
                const errorId = `forgejo-edit-${field}-error`;
                return (
                  <label key={field} className="grid gap-2">
                    <span className="text-xs font-medium">{label}</span>
                    <Input
                      nativeInput
                      ref={ref}
                      type={type}
                      autoComplete={autoComplete}
                      value={editDraft[field]}
                      placeholder={placeholder}
                      aria-invalid={Boolean(editErrors[field]) || undefined}
                      aria-describedby={editErrors[field] ? errorId : undefined}
                      onChange={(event) => updateEditDraft(field, event.target.value)}
                    />
                    {editErrors[field] ? (
                      <span id={errorId} className="text-xs text-destructive">
                        {editErrors[field]}
                      </span>
                    ) : null}
                  </label>
                );
              })}
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
                <label className="grid gap-2">
                  <span className="text-xs font-medium">SSH host (optional)</span>
                  <Input
                    nativeInput
                    ref={editSshHostRef}
                    type="text"
                    autoComplete="off"
                    value={editDraft.sshHost}
                    placeholder="Derived from the base URL"
                    aria-invalid={Boolean(editErrors.sshHost) || undefined}
                    aria-describedby={editErrors.sshHost ? "forgejo-edit-sshHost-error" : undefined}
                    onChange={(event) => updateEditDraft("sshHost", event.target.value)}
                  />
                  {editErrors.sshHost ? (
                    <span id="forgejo-edit-sshHost-error" className="text-xs text-destructive">
                      {editErrors.sshHost}
                    </span>
                  ) : null}
                </label>
                <label className="grid gap-2">
                  <span className="text-xs font-medium">SSH port</span>
                  <Input
                    nativeInput
                    ref={editSshPortRef}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65_535}
                    value={editDraft.sshPort}
                    aria-invalid={Boolean(editErrors.sshPort) || undefined}
                    aria-describedby={editErrors.sshPort ? "forgejo-edit-sshPort-error" : undefined}
                    onChange={(event) => updateEditDraft("sshPort", event.target.value)}
                  />
                  {editErrors.sshPort ? (
                    <span id="forgejo-edit-sshPort-error" className="text-xs text-destructive">
                      {editErrors.sshPort}
                    </span>
                  ) : null}
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                Use the SSH port from the repository remote, for example 2222. The stored token is
                not changed.
              </p>
              {editRequestError ? (
                <p role="alert" className="text-xs text-destructive">
                  {editRequestError}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button
                type="submit"
                disabled={editTarget !== null && busyConnectionId === editTarget.id}
              >
                <CheckCircle2Icon aria-hidden />
                Verify and save
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={credentialTarget !== null}
        onOpenChange={(open) => !open && closeCredentialDialog()}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Update Forgejo credential</DialogTitle>
            <DialogDescription>
              Replace the stored token for {credentialTarget?.displayName ?? "this connection"}. T3
              Code verifies the new token before saving it.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void replaceCredential();
            }}
          >
            <DialogPanel className="grid gap-4">
              <label className="grid gap-2">
                <span className="text-xs font-medium">New personal access token</span>
                <Input
                  nativeInput
                  ref={replacementTokenRef}
                  type="password"
                  autoComplete="new-password"
                  value={replacementToken}
                  aria-invalid={Boolean(credentialError) || undefined}
                  aria-describedby={credentialError ? "forgejo-replacement-token-error" : undefined}
                  onChange={(event) => {
                    setReplacementToken(event.target.value);
                    setCredentialError(null);
                  }}
                />
                {credentialError ? (
                  <span
                    id="forgejo-replacement-token-error"
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {credentialError}
                  </span>
                ) : null}
              </label>
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button
                type="submit"
                disabled={credentialTarget !== null && busyConnectionId === credentialTarget.id}
              >
                <KeyRoundIcon aria-hidden />
                Update credential
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

import {
  SourceControlConnectionAuthenticationError,
  type SourceControlConnectionCapabilities,
  type SourceControlConnectionId,
  type SourceControlConnectionIdentity,
  type SourceControlConnectionIncompatibleVersionError,
  SourceControlConnectionProviderUnavailableError,
  type SourceControlConnectionProviderKind,
  type SourceControlConnectionUrl,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface SourceControlConnectionVerificationInput {
  readonly provider: SourceControlConnectionProviderKind;
  readonly connectionId?: SourceControlConnectionId;
  readonly baseUrl: SourceControlConnectionUrl;
  readonly apiUrl?: SourceControlConnectionUrl;
  readonly token: string;
}

export interface SourceControlConnectionVerificationResult {
  readonly baseUrl: SourceControlConnectionUrl;
  readonly apiUrl: SourceControlConnectionUrl;
  readonly identity: SourceControlConnectionIdentity;
  readonly serverVersion: string;
  readonly capabilities: SourceControlConnectionCapabilities;
}

export type SourceControlConnectionVerificationError =
  | SourceControlConnectionAuthenticationError
  | SourceControlConnectionIncompatibleVersionError;

export type SourceControlConnectionVerifier = (
  input: SourceControlConnectionVerificationInput,
) => Effect.Effect<
  SourceControlConnectionVerificationResult,
  SourceControlConnectionVerificationError
>;

export class SourceControlConnectionVerifierRegistry extends Context.Service<
  SourceControlConnectionVerifierRegistry,
  {
    readonly verify: (
      input: SourceControlConnectionVerificationInput,
    ) => Effect.Effect<
      SourceControlConnectionVerificationResult,
      SourceControlConnectionVerificationError | SourceControlConnectionProviderUnavailableError
    >;
  }
>()("t3/sourceControl/connections/SourceControlConnectionVerifierRegistry") {}

export const make = (
  verifiers: Partial<Record<SourceControlConnectionProviderKind, SourceControlConnectionVerifier>>,
) =>
  SourceControlConnectionVerifierRegistry.of({
    verify: (input) => {
      const verifier = verifiers[input.provider];
      return verifier === undefined
        ? Effect.fail(
            new SourceControlConnectionProviderUnavailableError({ provider: input.provider }),
          )
        : verifier(input);
    },
  });

export const layer = (verifiers: Parameters<typeof make>[0]) =>
  Layer.succeed(SourceControlConnectionVerifierRegistry, make(verifiers));

export const layerEmpty = layer({});

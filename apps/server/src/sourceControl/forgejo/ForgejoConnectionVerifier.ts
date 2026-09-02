import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  SourceControlConnectionVerifierRegistry,
  make as makeRegistry,
} from "../connections/SourceControlConnectionVerifierRegistry.ts";
import { makeVerifier } from "./ForgejoHttpClient.ts";

export const layer = Layer.effect(
  SourceControlConnectionVerifierRegistry,
  Effect.map(makeVerifier, (forgejo) => makeRegistry({ forgejo })),
);

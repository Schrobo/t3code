import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SourceControlConnectionId } from "@t3tools/contracts";

import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
import { ForgejoApi } from "./forgejo/ForgejoApi.ts";

const connectionId = SourceControlConnectionId.make("00000000-0000-4000-8000-000000000253");

function makeProvider(forgejo: Partial<ForgejoApi["Service"]>) {
  return ForgejoSourceControlProvider.make.pipe(Effect.provide(Layer.mock(ForgejoApi)(forgejo)));
}

it.effect("maps Forgejo pull requests into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 51,
          title: "Native Forgejo provider",
          url: "https://forgejo.test/owner/repo/pulls/51",
          baseRefName: "main",
          headRefName: "feature/forgejo",
          state: "open",
          updatedAt: Option.some(DateTime.makeUnsafe("2026-08-31T12:00:00.000Z")),
        }),
    });

    const result = yield* provider.getChangeRequest({ cwd: "/repo", reference: "51" });
    assert.equal(result.provider, "forgejo");
    assert.equal(result.number, 51);
    assert.equal(result.headRefName, "feature/forgejo");
  }),
);

it.effect("routes repository search through the explicitly selected Forgejo connection", () =>
  Effect.gen(function* () {
    let received: Parameters<ForgejoApi["Service"]["searchRepositories"]>[0] | null = null;
    const provider = yield* makeProvider({
      searchRepositories: (input) => {
        received = input;
        return Effect.succeed([]);
      },
    });

    yield* provider.searchRepositories!({
      cwd: "/repo",
      connectionId,
      query: "t3code",
      limit: 20,
    });

    assert.deepStrictEqual(received, {
      cwd: "/repo",
      connectionId,
      query: "t3code",
      limit: 20,
    });
  }),
);

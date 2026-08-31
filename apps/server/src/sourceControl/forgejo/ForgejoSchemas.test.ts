import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ForgejoApiSettingsSchema,
  ForgejoPullRequestSchema,
  ForgejoRepositorySchema,
  ForgejoServerVersionSchema,
  ForgejoUserSchema,
  normalizeForgejoPullRequest,
} from "./ForgejoSchemas.ts";
import { forgejoV15Fixture } from "./fixtures/v15.ts";
import { forgejoV16Fixture } from "./fixtures/v16.ts";

for (const fixture of [forgejoV15Fixture, forgejoV16Fixture]) {
  it(`decodes the used Forgejo ${fixture.version.version} response fields tolerantly`, () => {
    const version = Schema.decodeUnknownSync(ForgejoServerVersionSchema)(fixture.version);
    const settings = Schema.decodeUnknownSync(ForgejoApiSettingsSchema)(fixture.settings);
    const user = Schema.decodeUnknownSync(ForgejoUserSchema)(fixture.user);
    const repository = Schema.decodeUnknownSync(ForgejoRepositorySchema)(fixture.repository);
    const pullRequest = Schema.decodeUnknownSync(ForgejoPullRequestSchema)(fixture.pullRequest);

    assert.equal(version.version, fixture.version.version);
    assert.equal(settings.max_response_items, fixture.settings.max_response_items);
    assert.equal(user.login, fixture.user.login);
    assert.equal(repository.full_name, fixture.repository.full_name);
    assert.equal(normalizeForgejoPullRequest(pullRequest).number, fixture.pullRequest.number);
  });
}

it("rejects a Forgejo pull request without fields required by T3", () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(ForgejoPullRequestSchema)({
      number: 1,
      title: "Missing branch data",
      html_url: "https://forgejo.test/owner/repo/pulls/1",
      state: "open",
    }),
  );
});

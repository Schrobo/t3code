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

const decodeVersion = Schema.decodeUnknownSync(ForgejoServerVersionSchema);
const decodeSettings = Schema.decodeUnknownSync(ForgejoApiSettingsSchema);
const decodeUser = Schema.decodeUnknownSync(ForgejoUserSchema);
const decodeRepository = Schema.decodeUnknownSync(ForgejoRepositorySchema);
const decodePullRequest = Schema.decodeUnknownSync(ForgejoPullRequestSchema);

for (const fixture of [forgejoV15Fixture, forgejoV16Fixture]) {
  it(`decodes the used Forgejo ${fixture.version.version} response fields tolerantly`, () => {
    const version = decodeVersion(fixture.version);
    const settings = decodeSettings(fixture.settings);
    const user = decodeUser(fixture.user);
    const repository = decodeRepository(fixture.repository);
    const pullRequest = decodePullRequest(fixture.pullRequest);

    assert.equal(version.version, fixture.version.version);
    assert.equal(settings.max_response_items, fixture.settings.max_response_items);
    assert.equal(user.login, fixture.user.login);
    assert.equal(repository.full_name, fixture.repository.full_name);
    assert.equal(normalizeForgejoPullRequest(pullRequest).number, fixture.pullRequest.number);
  });
}

it("rejects a Forgejo pull request without fields required by T3", () => {
  assert.throws(() =>
    decodePullRequest({
      number: 1,
      title: "Missing branch data",
      html_url: "https://forgejo.test/owner/repo/pulls/1",
      state: "open",
    }),
  );
});

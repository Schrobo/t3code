import { assert, describe, it } from "@effect/vitest";

import {
  isNightlyDesktopVersion,
  isPreviewDesktopVersion,
  resolveDefaultDesktopUpdateChannel,
} from "./updateChannels.ts";

describe("desktop update channels", () => {
  it("recognizes preview versions without assigning them an update channel", () => {
    assert.isTrue(isPreviewDesktopVersion("0.0.33-pr.42.abcdef0"));
    assert.isFalse(isPreviewDesktopVersion("0.0.33"));
    assert.isFalse(isNightlyDesktopVersion("0.0.33-pr.42.abcdef0"));
    assert.equal(resolveDefaultDesktopUpdateChannel("0.0.33-pr.42.abcdef0"), "latest");
  });
});

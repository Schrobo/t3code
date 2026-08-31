import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { paginateForgejo } from "./ForgejoPagination.ts";

it.effect("finds a matching pull request beyond Forgejo's first 50 results", () =>
  Effect.gen(function* () {
    const requestedPages: number[] = [];
    const pullRequests = yield* paginateForgejo({
      initialUrl: "https://forgejo.test/api/v1/repos/owner/repo/pulls?state=all&limit=50&page=1",
      fetchPage: (url) =>
        Effect.sync(() => {
          const page = Number(new URL(url).searchParams.get("page"));
          requestedPages.push(page);
          return {
            items:
              page === 1
                ? Array.from({ length: 50 }, (_, index) => ({ number: index + 1, head: "other" }))
                : page === 2
                  ? [{ number: 51, head: "feature/forgejo" }]
                  : [],
            headers: {},
          };
        }),
    });

    assert.equal(pullRequests.find((item) => item.head === "feature/forgejo")?.number, 51);
    assert.deepStrictEqual(requestedPages, [1, 2, 3]);
  }),
);

it.effect("follows RFC 8288 next links instead of assuming a fixed Forgejo page size", () =>
  Effect.gen(function* () {
    const requestedUrls: string[] = [];
    const items = yield* paginateForgejo({
      initialUrl: "https://forgejo.test/api/v1/repos/owner/repo/pulls?page=1&limit=50",
      fetchPage: (url) =>
        Effect.sync(() => {
          requestedUrls.push(url);
          return requestedUrls.length === 1
            ? {
                items: [1],
                headers: {
                  link: '<https://forgejo.test/api/v1/repos/owner/repo/pulls?page=7&limit=1>; rel="next"',
                },
              }
            : { items: [], headers: {} };
        }),
    });

    assert.deepStrictEqual(items, [1]);
    assert.match(requestedUrls[1] ?? "", /page=7/u);
  }),
);

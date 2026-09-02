import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const MAX_PAGES = 10_000;

export class ForgejoPaginationError extends Schema.TaggedErrorClass<ForgejoPaginationError>()(
  "ForgejoPaginationError",
  { reason: Schema.Literals(["too-many-pages", "repeated-page"]) },
) {
  override get message(): string {
    return "Forgejo pagination could not be completed safely.";
  }
}

export interface ForgejoPage<A> {
  readonly items: ReadonlyArray<A>;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

function linkTarget(linkHeader: string | undefined, relation: string): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = /^\s*<([^>]+)>\s*;(.*)$/u.exec(part);
    if (!match?.[1] || !match[2]) continue;
    const relations = Array.from(match[2].matchAll(/rel\s*=\s*"?([^";]+)"?/gu)).flatMap(
      (entry) => entry[1]?.trim().split(/\s+/u) ?? [],
    );
    if (relations.includes(relation)) return match[1];
  }
  return null;
}

const PAGINATION_BASE_URL = "https://forgejo-pagination.invalid/";

function isAbsoluteUrl(value: string): boolean {
  try {
    return new URL(value).origin.length > 0;
  } catch {
    return false;
  }
}

function resolveNextLink(current: string, linked: string): string {
  if (isAbsoluteUrl(linked)) return linked;
  if (isAbsoluteUrl(current)) return new URL(linked, current).toString();

  const resolved = new URL(linked, new URL(current, PAGINATION_BASE_URL));
  if (resolved.origin !== new URL(PAGINATION_BASE_URL).origin) return resolved.toString();
  const relative = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  return current.startsWith("/") ? relative : relative.replace(/^\//u, "");
}

function incrementPage(url: string): string {
  const absolute = isAbsoluteUrl(url);
  const parsed = new URL(url, PAGINATION_BASE_URL);
  const currentPage = Number.parseInt(parsed.searchParams.get("page") ?? "1", 10);
  parsed.searchParams.set("page", String(Number.isFinite(currentPage) ? currentPage + 1 : 2));
  if (absolute) return parsed.toString();
  const relative = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return url.startsWith("/") ? relative : relative.replace(/^\//u, "");
}

export function paginateForgejo<A, E>(input: {
  readonly initialUrl: string;
  readonly resultLimit?: number;
  readonly fetchPage: (url: string) => Effect.Effect<ForgejoPage<A>, E>;
}): Effect.Effect<ReadonlyArray<A>, E | ForgejoPaginationError> {
  return Effect.gen(function* () {
    const items: A[] = [];
    const visited = new Set<string>();
    let url: string | null = input.initialUrl;
    let pageCount = 0;

    while (url !== null) {
      if (pageCount >= MAX_PAGES) {
        return yield* new ForgejoPaginationError({ reason: "too-many-pages" });
      }
      if (visited.has(url)) {
        return yield* new ForgejoPaginationError({ reason: "repeated-page" });
      }
      visited.add(url);
      pageCount += 1;

      const result = yield* input.fetchPage(url);
      items.push(...result.items);
      if (input.resultLimit !== undefined && items.length >= input.resultLimit) {
        return items.slice(0, input.resultLimit);
      }
      if (result.items.length === 0) break;

      const linked = linkTarget(result.headers.link, "next");
      if (linked !== null) {
        url = resolveNextLink(url, linked);
      } else {
        url = incrementPage(url);
      }
    }

    return items;
  });
}

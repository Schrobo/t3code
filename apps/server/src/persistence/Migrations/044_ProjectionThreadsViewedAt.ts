import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  // The previous PR used migration ID 43 for viewed_at. Repair those databases
  // because the current migration 43 for unsettled_at is skipped by ID.
  if (!columns.some((column) => column.name === "unsettled_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN unsettled_at TEXT
    `;
  }

  if (!columns.some((column) => column.name === "viewed_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN viewed_at TEXT
    `;
  }

  // Existing completed threads must remain read after the server upgrade.
  yield* sql`
    UPDATE projection_threads
    SET viewed_at = COALESCE(viewed_at, updated_at, created_at)
    WHERE viewed_at IS NULL
  `;
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const previousPrLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ProjectionThreadsViewedAt", (it) => {
  it.effect("adds viewed_at after migration 043 and preserves unsettled_at", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at,
          unsettled_at
        ) VALUES (
          'thread-1',
          'project-1',
          'Historical thread',
          'full-access',
          'default',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          '2026-01-03T00:00:00.000Z'
        )
      `;

      const migrations = yield* runMigrations({ toMigrationInclusive: 44 });
      assert.deepEqual(migrations, [[44, "ProjectionThreadsViewedAt"]]);

      const rows = yield* sql<{
        readonly unsettledAt: string | null;
        readonly viewedAt: string | null;
      }>`
        SELECT
          unsettled_at AS "unsettledAt",
          viewed_at AS "viewedAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [
        {
          unsettledAt: "2026-01-03T00:00:00.000Z",
          viewedAt: "2026-01-02T00:00:00.000Z",
        },
      ]);

      const olderServerMigrations = yield* runMigrations({ toMigrationInclusive: 43 });
      assert.deepEqual(olderServerMigrations, []);
    }),
  );
});

previousPrLayer("044_ProjectionThreadsViewedAt previous PR upgrade", (it) => {
  it.effect("repairs the previous PR migration 043 without replacing viewed_at", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at
        ) VALUES (
          'thread-1',
          'project-1',
          'Previously migrated thread',
          'full-access',
          'default',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z'
        )
      `;
      yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN viewed_at TEXT
      `;
      yield* sql`
        UPDATE projection_threads
        SET viewed_at = '2026-01-01T12:00:00.000Z'
        WHERE thread_id = 'thread-1'
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (43, 'ProjectionThreadsViewedAt')
      `;

      const migrations = yield* runMigrations({ toMigrationInclusive: 44 });
      assert.deepEqual(migrations, [[44, "ProjectionThreadsViewedAt"]]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "unsettled_at"));

      const rows = yield* sql<{
        readonly unsettledAt: string | null;
        readonly viewedAt: string | null;
      }>`
        SELECT
          unsettled_at AS "unsettledAt",
          viewed_at AS "viewedAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [
        {
          unsettledAt: null,
          viewedAt: "2026-01-01T12:00:00.000Z",
        },
      ]);
    }),
  );
});

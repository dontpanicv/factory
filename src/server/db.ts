import { mkdirSync } from "node:fs";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { databaseFile, Settings } from "./config.ts";

/**
 * The migrations of the Factory database. Better Auth migrates its own tables in the same file.
 * Use expand-and-contract migrations: the previous release must still work after each one (AGENTS.md).
 */
export const migrations = SqliteMigrator.fromRecord({
  "0001_access_checks": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The cached results of the Google group check (src/server/auth/groups.ts).
    yield* sql`CREATE TABLE access_checks (
      email TEXT PRIMARY KEY,
      allowed INTEGER NOT NULL,
      checked_at INTEGER NOT NULL
    )`;
  }),
});

/** The SQLite client of the Factory database file, with all migrations applied. */
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* Settings;
    mkdirSync(settings.dataDir, { recursive: true });
    return SqliteMigrator.layer({ loader: migrations }).pipe(
      Layer.provideMerge(
        SqliteClient.layer({ filename: databaseFile(settings) })
      )
    );
  })
);

import { mkdirSync } from "node:fs";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { databaseFile, Settings } from "./config.ts";

/**
 * The migrations of the Factory database. Better Auth migrates its own tables in the same file.
 * Use expand-and-contract migrations: the previous release must still work after each one (AGENTS.md).
 */
/**
 * The Factory tables: what a person defines (agents, projects, shared resources, skills), the secrets,
 * and the runs of the agents. The agents' transcripts are in Pi Durable's own file.
 */
export const FACTORY_SCHEMA = [
  `CREATE TABLE definitions (
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (kind, name)
  )`,
  `CREATE TABLE secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    task_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    note TEXT,
    conversation_id TEXT,
    submission_id TEXT,
    claim TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    steps INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX runs_task ON runs (task_id)",
  "CREATE INDEX runs_agent ON runs (agent, started_at)",
];

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
  "0002_factory": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of FACTORY_SCHEMA) {
      yield* sql.unsafe(statement);
    }
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

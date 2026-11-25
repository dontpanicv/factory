import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Effect, Layer } from "effect";
import { databaseFile, Settings } from "./config.ts";

/**
 * The Factory database: one SQLite file. Each slice owns its tables and reaches them with
 * `openDatabase`. Better Auth and the Effect SQL client use the same file.
 */

/** The SQLite client of the Factory database file, with the migrations of `loader` applied. */
export const databaseLayer = (
  loader: ReturnType<typeof SqliteMigrator.fromRecord>
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* Settings;
      mkdirSync(settings.dataDir, { recursive: true });
      return SqliteMigrator.layer({ loader }).pipe(
        Layer.provideMerge(
          SqliteClient.layer({ filename: databaseFile(settings) })
        )
      );
    })
  );

/** A connection for a slice's own queries. */
export const openDatabase = (file: string) => {
  const db = new Database(file);
  db.run("PRAGMA busy_timeout = 5000");
  return db;
};

/**
 * What a person defines in Factory (agents, projects, shared resources, skills): one row for each
 * definition, with its settings as JSON, so a new setting needs no migration.
 */
export const DEFINITIONS_TABLE = `CREATE TABLE definitions (
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (kind, name)
  )`;

/** The definitions of one kind. A slice has one, for the kind that it owns. */
export interface Definitions<T> {
  readonly get: (name: string) => T | null;
  readonly list: () => T[];
  /** Check a definition and keep it. Throws an Error that says what is wrong. */
  readonly put: (input: unknown) => T;
  readonly remove: (name: string) => void;
}

export const definitions = <T extends { readonly name: string }>(
  db: Database,
  kind: string,
  /** Checks a definition and gives a setting that is not there its default. */
  decode: (input: unknown) => T
): Definitions<T> => ({
  get: (name) => {
    const row = db
      .query<{ config: string }, [string, string]>(
        "SELECT config FROM definitions WHERE kind = ? AND name = ?"
      )
      .get(kind, name);
    return row === null ? null : decode(JSON.parse(row.config));
  },
  // Decoded again: a definition from before a setting was added gets that setting's default.
  list: () =>
    db
      .query<{ config: string }, [string]>(
        "SELECT config FROM definitions WHERE kind = ? ORDER BY name"
      )
      .all(kind)
      .map((row) => decode(JSON.parse(row.config))),
  put: (input) => {
    const value = decode(input);
    db.query(
      `INSERT INTO definitions (kind, name, config, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (kind, name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`
    ).run(kind, value.name, JSON.stringify(value), Date.now());
    return value;
  },
  remove: (name) => {
    db.query("DELETE FROM definitions WHERE kind = ? AND name = ?").run(
      kind,
      name
    );
  },
});

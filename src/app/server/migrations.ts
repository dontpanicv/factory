import { SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { RUNS_TABLES, SCHEDULE_TIMES_TABLE } from "../../agents/server/runs.ts";
import { ACCESS_CHECKS_TABLE } from "../../identity/server/groups.ts";
import { SECRETS_TABLE } from "../../secrets/server/secrets.ts";
import { DEFINITIONS_TABLE } from "../../shared/server/database.ts";

/**
 * The migrations of the Factory database, in the order in which they were added. Each slice owns
 * the tables that it names here. Better Auth migrates its own tables in the same file. Use
 * expand-and-contract migrations: the previous release must still work after each one (AGENTS.md).
 */

const run = (statements: readonly string[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of statements) {
      yield* sql.unsafe(statement);
    }
  });

export const migrations = SqliteMigrator.fromRecord({
  "0001_access_checks": run([ACCESS_CHECKS_TABLE]),
  "0002_factory": run([DEFINITIONS_TABLE, SECRETS_TABLE, ...RUNS_TABLES]),
  "0003_schedule_times": run([SCHEDULE_TIMES_TABLE]),
});

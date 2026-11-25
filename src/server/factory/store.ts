import { Database } from "bun:sqlite";
import { Cron, Effect, Schema } from "effect";

/**
 * What a person defines in Factory, and the runs of the agents. One row for each definition, with
 * its settings as JSON: a new setting needs no migration.
 */

const text = (fallback = "") =>
  Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(fallback)));
const names = Schema.Array(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed<readonly string[]>([]))
);
/** A name is also a host name, a directory and a part of a container name. */
const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/));

const Schedule = Schema.Struct({
  /** Where the task is made. */
  channel: Schema.String,
  /** Five fields: minute, hour, day, month, weekday. */
  cron: Schema.String,
  /** The text of the task. */
  text: Schema.String,
  /** An IANA time zone: `Europe/Prague`. */
  zone: text("UTC"),
});

export const Agent = Schema.Struct({
  /** Channels whose tasks it does. `pipes/` is `pipes` and all channels below it. */
  channels: names,
  /** Its role, in one line. */
  description: text(),
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true))
  ),
  /** The container image of its sandbox. Empty: the Factory image. */
  image: text(),
  instructions: text(),
  /** The most tool rounds of one run. */
  maxTurns: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(80))),
  /** `provider/model`, as Pi names it. */
  model: text(),
  name: Name,
  /** How many tasks it does at one time. */
  parallel: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  /** Repositories that are checked out in its sandbox. */
  projects: names,
  /** Shared resources that its sandbox can reach. */
  resources: names,
  schedules: Schema.Array(Schedule).pipe(
    Schema.withDecodingDefault(
      Effect.succeed<readonly (typeof Schedule.Encoded)[]>([])
    )
  ),
  /** Secrets that its sandbox gets as environment variables. */
  secrets: names,
  skills: names,
  thinking: text("medium"),
});
export type Agent = typeof Agent.Type;

export const Project = Schema.Struct({
  branch: text("main"),
  name: Name,
  /** Shell commands that run in the checkout: `bun install`. */
  setup: text(),
  /** The secret with the token that reads and pushes the repository. Empty: a public repository. */
  tokenSecret: text(),
  url: Schema.String,
});
export type Project = typeof Project.Type;

export const Resource = Schema.Struct({
  /** The command of the container. Empty: the command of the image. */
  command: text(),
  description: text(),
  /** `KEY=value` lines. */
  env: text(),
  image: Schema.String,
  name: Name,
  /** Secrets that the container gets as environment variables. */
  secrets: names,
});
export type Resource = typeof Resource.Type;

export const Skill = Schema.Struct({
  body: text(),
  description: text(),
  name: Name,
});
export type Skill = typeof Skill.Type;

interface Definitions {
  agents: Agent;
  projects: Project;
  resources: Resource;
  skills: Skill;
}
export type Kind = keyof Definitions;

const DECODE: { [K in Kind]: (input: unknown) => Definitions[K] } = {
  agents: Schema.decodeUnknownSync(Agent),
  projects: Schema.decodeUnknownSync(Project),
  resources: Schema.decodeUnknownSync(Resource),
  skills: Schema.decodeUnknownSync(Skill),
};
export const isKind = (value: string): value is Kind => value in DECODE;

/** Does the agent do the tasks of this channel? `pipes/` is `pipes` and all channels below it. */
export const consumes = (
  agent: { readonly channels: readonly string[] },
  channel: string
) =>
  agent.channels.some((pattern) =>
    pattern.endsWith("/")
      ? channel === pattern.slice(0, -1) || channel.startsWith(pattern)
      : channel === pattern
  );

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** `KEY=value` lines as a record. Lines without `=` are ignored. */
export const parseEnv = (lines: string) => {
  const env: Record<string, string> = {};
  for (const line of lines.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) {
      env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  return env;
};

/** The next time of a schedule after `after`, or null when its cron or its zone is not correct. */
export const nextRun = (
  schedule: { readonly cron: string; readonly zone: string },
  after: Date
): Date | null => {
  try {
    return Cron.next(Cron.parseUnsafe(schedule.cron, schedule.zone), after);
  } catch {
    return null;
  }
};

export type RunState =
  /** The sandbox starts. */
  | "starting"
  | "running"
  /** The agent answered and the task is complete. */
  | "done"
  /** The agent gave the task to a person. */
  | "blocked"
  /** The agent said that it cannot do the task. */
  | "failed"
  /** The run broke: the model, the sandbox or the turn limit. */
  | "error"
  /** A person stopped it. */
  | "stopped"
  /** Its claim on the task ended: a person finished or canceled the task. */
  | "lost";

export const LIVE: readonly RunState[] = ["starting", "running"];

export interface Run {
  readonly agent: string;
  readonly channel: string;
  /** The claim on the task: the board asks for it on each write. */
  readonly claim: { readonly epoch: number; readonly token: string } | null;
  /** The agent's conversation in Pi Durable. */
  readonly conversationId: number | null;
  readonly cost: number;
  readonly endedAt: number | null;
  readonly id: string;
  /** Why it ended as it did. */
  readonly note: string | null;
  readonly startedAt: number;
  readonly state: RunState;
  readonly steps: number;
  readonly submissionId: number | null;
  readonly taskId: string;
  readonly title: string;
  readonly tokens: number;
}

interface RunRow {
  agent: string;
  channel: string;
  claim: string | null;
  conversation_id: string | null;
  cost: number;
  ended_at: number | null;
  id: string;
  note: string | null;
  started_at: number;
  state: RunState;
  steps: number;
  submission_id: string | null;
  task_id: string;
  title: string;
  tokens: number;
}

const toRun = (row: RunRow): Run => ({
  agent: row.agent,
  channel: row.channel,
  claim: row.claim === null ? null : JSON.parse(row.claim),
  conversationId:
    row.conversation_id === null ? null : Number(row.conversation_id),
  cost: row.cost,
  endedAt: row.ended_at,
  id: row.id,
  note: row.note,
  startedAt: row.started_at,
  state: row.state,
  steps: row.steps,
  submissionId: row.submission_id === null ? null : Number(row.submission_id),
  taskId: row.task_id,
  title: row.title,
  tokens: row.tokens,
});

const RUN_COLUMNS: Record<string, string> = {
  claim: "claim",
  conversationId: "conversation_id",
  cost: "cost",
  endedAt: "ended_at",
  note: "note",
  state: "state",
  steps: "steps",
  submissionId: "submission_id",
  tokens: "tokens",
};

export class Store {
  readonly #db: Database;

  constructor(file: string) {
    this.#db = new Database(file);
    this.#db.run("PRAGMA busy_timeout = 5000");
  }

  /** For a database without the migrations (tests). */
  createTables(statements: readonly string[]) {
    for (const statement of statements) {
      this.#db.run(statement);
    }
  }

  list<K extends Kind>(kind: K): Definitions[K][] {
    const rows = this.#db
      .query<{ config: string }, [string]>(
        "SELECT config FROM definitions WHERE kind = ? ORDER BY name"
      )
      .all(kind);
    return rows.map((row) => JSON.parse(row.config));
  }

  get<K extends Kind>(kind: K, name: string): Definitions[K] | null {
    const row = this.#db
      .query<{ config: string }, [string, string]>(
        "SELECT config FROM definitions WHERE kind = ? AND name = ?"
      )
      .get(kind, name);
    return row === null ? null : JSON.parse(row.config);
  }

  /** Check a definition and keep it. Throws an Error that says what is wrong. */
  put<K extends Kind>(kind: K, input: unknown): Definitions[K] {
    const value = DECODE[kind](input);
    if (kind === "agents") {
      for (const schedule of (value as Agent).schedules) {
        if (nextRun(schedule, new Date()) === null) {
          throw new Error(
            `"${schedule.cron}" in ${schedule.zone} is not a schedule. Use five fields: minute hour day month weekday.`
          );
        }
      }
    }
    this.#db
      .query(
        `INSERT INTO definitions (kind, name, config, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (kind, name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`
      )
      .run(kind, value.name, JSON.stringify(value), Date.now());
    return value;
  }

  remove(kind: Kind, name: string) {
    this.#db
      .query("DELETE FROM definitions WHERE kind = ? AND name = ?")
      .run(kind, name);
  }

  /** The names only: a value never leaves the server, except into a sandbox. */
  secretNames(): string[] {
    return this.#db
      .query<{ name: string }, []>("SELECT name FROM secrets ORDER BY name")
      .all()
      .map((row) => row.name);
  }

  secret(name: string): string | undefined {
    return this.#db
      .query<{ value: string }, [string]>(
        "SELECT value FROM secrets WHERE name = ?"
      )
      .get(name)?.value;
  }

  /** The secrets of these names that exist, as environment variables. */
  secrets(wanted: readonly string[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of wanted) {
      const value = this.secret(name);
      if (value !== undefined) {
        env[name] = value;
      }
    }
    return env;
  }

  setSecret(name: string, value: string) {
    if (!SECRET_NAME.test(name)) {
      throw new Error(
        "A secret has the name of an environment variable: GITHUB_TOKEN."
      );
    }
    this.#db
      .query(
        `INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(name, value, Date.now());
  }

  removeSecret(name: string) {
    this.#db.query("DELETE FROM secrets WHERE name = ?").run(name);
  }

  insertRun(run: Run) {
    this.#db
      .query(
        `INSERT INTO runs (id, agent, task_id, channel, title, state, claim, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.agent,
        run.taskId,
        run.channel,
        run.title,
        run.state,
        run.claim === null ? null : JSON.stringify(run.claim),
        run.startedAt
      );
  }

  updateRun(id: string, change: Partial<Omit<Run, "id">>) {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(change)) {
      const column = RUN_COLUMNS[key];
      if (column !== undefined) {
        sets.push(`${column} = ?`);
        values.push(
          value !== null && typeof value === "object"
            ? JSON.stringify(value)
            : (value as string | number | null)
        );
      }
    }
    if (sets.length > 0) {
      this.#db
        .query(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`)
        .run(...values, id);
    }
  }

  run(id: string): Run | null {
    const row = this.#db
      .query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?")
      .get(id);
    return row === null ? null : toRun(row);
  }

  /** Runs, newest first. */
  runs(
    filter: {
      readonly agent?: string;
      readonly live?: boolean;
      readonly since?: number;
      readonly task?: string;
    } = {},
    limit = 50
  ): Run[] {
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (filter.agent !== undefined) {
      where.push("agent = ?");
      values.push(filter.agent);
    }
    if (filter.task !== undefined) {
      where.push("task_id = ?");
      values.push(filter.task);
    }
    if (filter.since !== undefined) {
      where.push("started_at >= ?");
      values.push(filter.since);
    }
    if (filter.live === true) {
      where.push("state IN ('starting', 'running')");
    }
    return this.#db
      .query<RunRow, (string | number)[]>(
        `SELECT * FROM runs ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
         ORDER BY started_at DESC LIMIT ?`
      )
      .all(...values, limit)
      .map(toRun);
  }
}

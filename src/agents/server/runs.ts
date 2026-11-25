import type { Database } from "bun:sqlite";

/** The runs of the agents: one for each time an agent takes a task. The transcripts are in Pi Durable's own file. */

export const RUNS_TABLES = [
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

/** The next time of each schedule, so a schedule that was due while Factory was down fires late. */
export const SCHEDULE_TIMES_TABLE = `CREATE TABLE schedule_times (
    key TEXT PRIMARY KEY,
    next_at INTEGER NOT NULL
  )`;

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

const COLUMNS: Record<string, string> = {
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

export interface RunFilter {
  readonly agent?: string;
  /** Only the runs that work now. */
  readonly live?: boolean;
  readonly since?: number;
  readonly task?: string;
}

export interface Runs {
  readonly get: (id: string) => Run | null;
  readonly insert: (run: Run) => void;
  /** Runs, newest first. */
  readonly list: (filter?: RunFilter, limit?: number) => Run[];
  readonly removeScheduleTime: (key: string) => void;
  /** The next time of each schedule, by its key. */
  readonly scheduleTimes: () => Map<string, number>;
  readonly setScheduleTime: (key: string, at: number) => void;
  readonly update: (id: string, change: Partial<Omit<Run, "id">>) => void;
}

const where = (filter: RunFilter) => {
  const parts: string[] = [];
  const values: (string | number)[] = [];
  if (filter.agent !== undefined) {
    parts.push("agent = ?");
    values.push(filter.agent);
  }
  if (filter.task !== undefined) {
    parts.push("task_id = ?");
    values.push(filter.task);
  }
  if (filter.since !== undefined) {
    parts.push("started_at >= ?");
    values.push(filter.since);
  }
  if (filter.live === true) {
    parts.push("state IN ('starting', 'running')");
  }
  return {
    sql: parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`,
    values,
  };
};

export const runsOf = (db: Database): Runs => ({
  get: (id) => {
    const row = db
      .query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?")
      .get(id);
    return row === null ? null : toRun(row);
  },
  insert: (run) => {
    db.query(
      `INSERT INTO runs (id, agent, task_id, channel, title, state, claim, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      run.id,
      run.agent,
      run.taskId,
      run.channel,
      run.title,
      run.state,
      run.claim === null ? null : JSON.stringify(run.claim),
      run.startedAt
    );
  },
  list: (filter = {}, limit = 50) => {
    const { sql, values } = where(filter);
    return db
      .query<RunRow, (string | number)[]>(
        `SELECT * FROM runs ${sql} ORDER BY started_at DESC LIMIT ?`
      )
      .all(...values, limit)
      .map(toRun);
  },
  removeScheduleTime: (key) => {
    db.query("DELETE FROM schedule_times WHERE key = ?").run(key);
  },
  scheduleTimes: () =>
    new Map(
      db
        .query<{ key: string; next_at: number }, []>(
          "SELECT key, next_at FROM schedule_times"
        )
        .all()
        .map((row) => [row.key, row.next_at])
    ),
  setScheduleTime: (key, at) => {
    db.query(
      `INSERT INTO schedule_times (key, next_at) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET next_at = excluded.next_at`
    ).run(key, at);
  },
  update: (id, change) => {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(change)) {
      const column = COLUMNS[key];
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
      db.query(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(
        ...values,
        id
      );
    }
  },
});

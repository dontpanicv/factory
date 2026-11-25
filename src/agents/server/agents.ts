import type { Database } from "bun:sqlite";
import { Cron, Effect, Schema } from "effect";
import { definitions } from "../../shared/server/database.ts";
import { Name, names, text } from "../../shared/server/schema.ts";

/** Agents: who they are, which channels they work on, and what their sandboxes get. */

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
  maxTurns: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(80))),
  /** `provider/model`, as Pi names it. */
  model: text(),
  name: Name,
  /** How many tasks it does at one time. */
  parallel: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
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

const decode = Schema.decodeUnknownSync(Agent);

/** An agent with schedules that have correct times. Throws an Error that says what is wrong. */
const check = (input: unknown) => {
  const agent = decode(input);
  for (const count of [agent.maxTurns, agent.parallel]) {
    if (!(Number.isInteger(count) && count >= 1)) {
      throw new Error(
        "The tool rounds and the tasks at one time are whole numbers, 1 or more."
      );
    }
  }
  for (const schedule of agent.schedules) {
    if (nextRun(schedule, new Date()) === null) {
      throw new Error(
        `"${schedule.cron}" in ${schedule.zone} is not a schedule. Use five fields: minute hour day month weekday.`
      );
    }
  }
  return agent;
};

export const agentsOf = (db: Database) =>
  definitions<Agent>(db, "agents", check);

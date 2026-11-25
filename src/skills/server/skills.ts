import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import { definitions } from "../../shared/server/database.ts";
import { Name, text } from "../../shared/server/schema.ts";

/** Skills: instructions for one kind of work, that an agent reads when a task needs them. */

export const Skill = Schema.Struct({
  body: text(),
  description: text(),
  name: Name,
});
export type Skill = typeof Skill.Type;

export const skillsOf = (db: Database) =>
  definitions<Skill>(db, "skills", Schema.decodeUnknownSync(Skill));

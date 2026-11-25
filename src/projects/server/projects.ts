import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import { definitions } from "../../shared/server/database.ts";
import { Name, text } from "../../shared/server/schema.ts";

/** Projects: the Git repositories that agents work on. A sandbox checks out the projects of its agent. */

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

export const projectsOf = (db: Database) =>
  definitions<Project>(db, "projects", Schema.decodeUnknownSync(Project));

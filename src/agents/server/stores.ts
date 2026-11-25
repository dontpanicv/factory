import type { Project } from "../../projects/server/projects.ts";
import type { Resource } from "../../sandbox/server/resources.ts";
import type { Secrets } from "../../secrets/server/secrets.ts";
import type { Definitions } from "../../shared/server/database.ts";
import type { Skill } from "../../skills/server/skills.ts";
import type { Agent } from "./agents.ts";
import type { Runs } from "./runs.ts";

/** What an agent at work reads: its own definition and runs, and what the other slices define for it. */
export interface Stores {
  readonly agents: Definitions<Agent>;
  readonly projects: Definitions<Project>;
  readonly resources: Definitions<Resource>;
  readonly runs: Runs;
  readonly secrets: Secrets;
  readonly skills: Definitions<Skill>;
}

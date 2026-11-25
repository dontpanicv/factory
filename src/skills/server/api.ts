import type { Definitions } from "../../shared/server/database.ts";
import { definitionRoute } from "../../shared/server/http.ts";
import type { Skill } from "./skills.ts";

/** `POST /skills` saves a skill and `DELETE /skills/<name>` removes one. */
export const skillsRoute = (skills: Definitions<Skill>) =>
  definitionRoute(skills);

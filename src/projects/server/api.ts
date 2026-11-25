import type { Definitions } from "../../shared/server/database.ts";
import { definitionRoute } from "../../shared/server/http.ts";
import type { Project } from "./projects.ts";

/** `POST /projects` saves a project and `DELETE /projects/<name>` removes one. */
export const projectsRoute = (projects: Definitions<Project>) =>
  definitionRoute(projects);

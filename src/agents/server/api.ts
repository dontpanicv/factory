import type { Definitions } from "../../shared/server/database.ts";
import {
  definitionRoute,
  json,
  problem,
  type Route,
} from "../../shared/server/http.ts";
import type { Agent } from "./agents.ts";
import type { Runner } from "./runner.ts";
import type { Runs } from "./runs.ts";

/** The endpoints of the agents and of their runs. */

const RUNS_MAX = 200;

/** Save and remove agents, and `POST /agents/<name>/schedules/<index>` makes the task of a schedule now. */
export const agentsRoute = (parts: {
  readonly agents: Definitions<Agent>;
  readonly runner: Runner;
}): Route => {
  const definition = definitionRoute(parts.agents);
  return async (call) => {
    const [name, action, index] = call.path;
    if (
      name !== undefined &&
      action === "schedules" &&
      index !== undefined &&
      call.method === "POST"
    ) {
      return json({ task: await parts.runner.runNow(name, Number(index)) });
    }
    const answer = await definition(call);
    // A changed agent can take tasks that wait.
    parts.runner.tick();
    return answer;
  };
};

/** `GET /runs` lists runs, `GET /runs/<id>` is one run with its steps, and `POST /runs/<id>/stop` stops it. */
export const runsRoute =
  (parts: { readonly runner: Runner; readonly runs: Runs }): Route =>
  async ({ by, method, path, query }) => {
    const { runner, runs } = parts;
    const [id, action] = path;
    if (id === undefined) {
      const agent = query.get("agent");
      const task = query.get("task");
      return json({
        runs: runs.list(
          {
            ...(agent === null ? {} : { agent }),
            ...(task === null ? {} : { task }),
          },
          Math.min(Number(query.get("limit") ?? "50"), RUNS_MAX)
        ),
      });
    }
    const run = runs.get(id);
    if (run === null) {
      return problem(404, "not_found", "No such run.");
    }
    if (action === "stop" && method === "POST") {
      await runner.stop(run.id, by);
      return json({ ok: true });
    }
    return action === undefined
      ? json({ run, steps: await runner.steps(run) })
      : null;
  };

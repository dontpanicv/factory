import type { Models } from "@earendil-works/pi-ai/models";
import type { Board } from "@vercel/board";
import { agentsRoute, runsRoute } from "../../agents/server/api.ts";
import type { Runner } from "../../agents/server/runner.ts";
import type { Stores } from "../../agents/server/stores.ts";
import { flowRoute } from "../../flow/server/api.ts";
import { projectsRoute } from "../../projects/server/api.ts";
import { resourceStates, resourcesRoute } from "../../sandbox/server/api.ts";
import {
  DEFAULT_IMAGE,
  type SandboxProvider,
} from "../../sandbox/server/sandbox.ts";
import { secretsRoute } from "../../secrets/server/api.ts";
import {
  type Call,
  json,
  problem,
  type Route,
} from "../../shared/server/http.ts";
import { skillsRoute } from "../../skills/server/api.ts";

/**
 * Factory's REST API at `/api/factory`: each slice has its own part of it, and the root is one
 * view of all slices for the pages.
 */

export const FACTORY_PATH = "/api/factory";

/** The slices of Factory at work in this process. */
export interface FactoryParts extends Stores {
  readonly board: Board;
  readonly models: Models;
  readonly provider: SandboxProvider;
  readonly runner: Runner;
}

/** All definitions with their state now: what the pages show. */
const overview =
  (parts: FactoryParts): Route =>
  async () => {
    const { agents, board, models, projects, provider, runner, runs } = parts;
    const next = runner.nextRuns();
    return json({
      agents: agents.list().map((agent) => ({
        ...agent,
        last: runs.list({ agent: agent.name }, 1)[0] ?? null,
        live: runs.list({ agent: agent.name, live: true }),
        next: agent.schedules.map(
          (_schedule, index) => next[`${agent.name}|${index}`] ?? null
        ),
      })),
      channels: (await board.channels()).channels.map(
        (channel) => channel.path
      ),
      image: DEFAULT_IMAGE,
      models: (await models.getAvailable()).map(
        (model) => `${model.provider}/${model.id}`
      ),
      projects: projects.list(),
      resources: await resourceStates(parts),
      sandbox: provider.kind,
      secrets: parts.secrets.names(),
      skills: parts.skills.list(),
    });
  };

/** The route of each first part of the address after `/api/factory`. */
export const routesOf = (parts: FactoryParts): Record<string, Route> => ({
  "": overview(parts),
  agents: agentsRoute(parts),
  flow: flowRoute(parts),
  projects: projectsRoute(parts.projects),
  resources: resourcesRoute(parts),
  runs: runsRoute(parts),
  secrets: secretsRoute(parts.secrets),
  skills: skillsRoute(parts.skills),
});

/** Answer one request of a signed-in person. */
export const handle = async (
  routes: Record<string, Route>,
  request: Request,
  by: string
): Promise<Response> => {
  const url = new URL(request.url);
  const [slice = "", ...path] = url.pathname
    .slice(FACTORY_PATH.length)
    .split("/")
    .filter((part) => part !== "")
    .map(decodeURIComponent);
  const call: Call = {
    body: async () =>
      (await request.json().catch(() => ({}))) as Record<string, unknown>,
    by,
    method: request.method,
    path,
    query: url.searchParams,
  };
  try {
    const answer = await routes[slice]?.(call);
    return answer ?? problem(404, "not_found", "No such endpoint.");
  } catch (error) {
    return problem(
      400,
      "invalid",
      error instanceof Error ? error.message : String(error)
    );
  }
};

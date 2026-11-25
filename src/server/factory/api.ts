import type { Models } from "@earendil-works/pi-ai/models";
import type { Board } from "@vercel/board";
import { loadFlow } from "./flow.ts";
import type { Runner } from "./runner.ts";
import { DEFAULT_IMAGE, type SandboxProvider } from "./sandbox.ts";
import { isKind, parseEnv, type Store } from "./store.ts";

/**
 * Factory's REST API at `/api/factory`: the definitions (agents, projects, shared resources,
 * skills), the secrets (names only), the runs with their logs, and the flow.
 */

export const FACTORY_PATH = "/api/factory";

export interface FactoryParts {
  readonly board: Board;
  readonly models: Models;
  readonly provider: SandboxProvider;
  readonly runner: Runner;
  readonly store: Store;
}

const DAY_MS = 86_400_000;
const RUNS_MAX = 200;

/** A run's claim on its task is a credential: it stays in the server. */
const json = (body: unknown, status = 200) =>
  new Response(
    JSON.stringify(body, (key, value) => (key === "claim" ? undefined : value)),
    { headers: { "content-type": "application/json" }, status }
  );
const problem = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

const overview = async ({
  board,
  models,
  provider,
  runner,
  store,
}: FactoryParts) => {
  const next = runner.nextRuns();
  const states = await provider.resourceStates().catch(() => null);
  return {
    agents: store.list("agents").map((agent) => ({
      ...agent,
      last: store.runs({ agent: agent.name }, 1)[0] ?? null,
      live: store.runs({ agent: agent.name, live: true }),
      next: agent.schedules.map(
        (_schedule, index) => next[`${agent.name}|${index}`] ?? null
      ),
    })),
    channels: (await board.channels()).channels.map((channel) => channel.path),
    image: DEFAULT_IMAGE,
    models: (await models.getAvailable()).map(
      (model) => `${model.provider}/${model.id}`
    ),
    projects: store.list("projects"),
    resources: store.list("resources").map((resource) => ({
      ...resource,
      // `unknown`: the provider did not answer (Docker does not run).
      state: states === null ? "unknown" : (states[resource.name] ?? "stopped"),
    })),
    sandbox: provider.kind,
    secrets: store.secretNames(),
    skills: store.list("skills"),
  };
};

/** One request: `path` is the parts of the address after `/api/factory`. */
interface Call {
  readonly body: () => Promise<Record<string, unknown>>;
  readonly by: string;
  readonly method: string;
  readonly parts: FactoryParts;
  readonly path: readonly string[];
  readonly query: URLSearchParams;
}

type Answer = Promise<Response | null>;

const flow = async ({ parts, query }: Call): Answer => {
  const since = Date.now() - Number(query.get("days") ?? "30") * DAY_MS;
  return json(
    await loadFlow(
      parts.board,
      parts.store.runs({ since }, 5000),
      parts.store.list("agents"),
      since
    )
  );
};

const runs = async ({ by, method, parts, path, query }: Call): Answer => {
  const { runner, store } = parts;
  const [, id, action] = path;
  if (id === undefined) {
    const agent = query.get("agent");
    const task = query.get("task");
    return json({
      runs: store.runs(
        {
          ...(agent === null ? {} : { agent }),
          ...(task === null ? {} : { task }),
        },
        Math.min(Number(query.get("limit") ?? "50"), RUNS_MAX)
      ),
    });
  }
  const run = store.run(id);
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

const secrets = async ({ body, method, parts, path }: Call): Answer => {
  const [, name] = path;
  if (name === undefined && method === "POST") {
    const input = await body();
    parts.store.setSecret(String(input.name ?? ""), String(input.value ?? ""));
    return json({ ok: true });
  }
  if (name !== undefined && method === "DELETE") {
    parts.store.removeSecret(name);
    return json({ ok: true });
  }
  return null;
};

/** Start or stop a shared resource. A start makes a new container, so a saved change applies. */
const power = async (parts: FactoryParts, name: string, action: string) => {
  const resource = parts.store.get("resources", name);
  if (resource === null) {
    return problem(404, "not_found", "No such resource.");
  }
  await parts.provider.resourceDown(name);
  if (action === "start") {
    await parts.provider.resourceUp({
      command: resource.command,
      env: {
        ...parseEnv(resource.env),
        ...parts.store.secrets(resource.secrets),
      },
      image: resource.image,
      name,
    });
  }
  return json({ ok: true });
};

const definitions = async ({ body, method, parts, path }: Call): Answer => {
  const { provider, runner, store } = parts;
  const [kind = "", name, action, extra] = path;
  if (!isKind(kind)) {
    return null;
  }
  if (name === undefined) {
    if (method !== "POST") {
      return null;
    }
    const saved = store.put(kind, await body());
    runner.tick();
    return json(saved);
  }
  if (action === undefined && method === "DELETE") {
    store.remove(kind, name);
    if (kind === "resources") {
      await provider.resourceDown(name);
    }
    return json({ ok: true });
  }
  if (method !== "POST" || action === undefined) {
    return null;
  }
  if (kind === "resources") {
    return power(parts, name, action);
  }
  return kind === "agents" && action === "schedules" && extra !== undefined
    ? json({ task: await runner.runNow(name, Number(extra)) })
    : null;
};

const ROUTES: Record<string, (call: Call) => Answer> = {
  "": async ({ parts }) => json(await overview(parts)),
  flow,
  runs,
  secrets,
};

/** Answer one request of a signed-in person. */
export const handle = async (
  parts: FactoryParts,
  request: Request,
  by: string
): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname
    .slice(FACTORY_PATH.length)
    .split("/")
    .filter((part) => part !== "")
    .map(decodeURIComponent);
  const call: Call = {
    body: async () =>
      (await request.json().catch(() => ({}))) as Record<string, unknown>,
    by,
    method: request.method,
    parts,
    path,
    query: url.searchParams,
  };
  try {
    const route = ROUTES[path[0] ?? ""] ?? definitions;
    return (
      (await route(call)) ?? problem(404, "not_found", "No such endpoint.")
    );
  } catch (error) {
    return problem(
      400,
      "invalid",
      error instanceof Error ? error.message : String(error)
    );
  }
};

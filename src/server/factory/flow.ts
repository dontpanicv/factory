import type { Board, MessageView } from "@vercel/board";
import { type Agent, consumes, type Run } from "./store.ts";

/**
 * How tasks move through the factory: each channel is a node, and an edge counts the tasks that
 * went from one node to the next. A task that an agent made with `board_task` came from the
 * channel of the agent's own task (label `factory.from`); other tasks came from people or from a
 * schedule. A finished task that made no new task goes to an end node.
 */

export interface FlowNode {
  /** The agents that do the tasks of the channel. */
  readonly agents: readonly string[];
  readonly id: string;
  readonly kind: "channel" | "end" | "source";
  readonly label: string;
  /** The median time of an agent's run on a task of the channel, or null. */
  readonly medianRunMs: number | null;
  /** Tasks that are not finished. */
  readonly open: number;
  readonly total: number;
}

export interface FlowEdge {
  readonly count: number;
  readonly from: string;
  /** The newest tasks that went this way. */
  readonly tasks: readonly string[];
  readonly to: string;
}

export interface Flow {
  readonly edges: readonly FlowEdge[];
  readonly nodes: readonly FlowNode[];
}

const ENDS: Record<string, string> = {
  canceled: "canceled",
  completed: "done",
  failed: "failed",
};
const EDGE_TASKS = 5;
const PAGE = 100;
const PAGES_MAX = 30;

const CHANNEL_NODE = /^channel:/;

const median = (values: number[]) => {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

/** The flow of these tasks. `all` also has older tasks, to find where a task came from. */
export const flowOf = (
  tasks: readonly MessageView[],
  all: readonly MessageView[],
  runs: readonly Run[],
  agents: readonly Agent[]
): Flow => {
  const byId = new Map(all.map((task) => [task.id, task]));
  const parents = new Set(
    all.flatMap((task) => task.labels["factory.from"] ?? [])
  );
  const edges = new Map<string, { count: number; tasks: string[] }>();
  const sources = new Set<string>();
  const ends = new Set<string>();
  const add = (from: string, to: string, task: string) => {
    const key = `${from}\n${to}`;
    const edge = edges.get(key) ?? { count: 0, tasks: [] };
    edge.count += 1;
    if (edge.tasks.length < EDGE_TASKS) {
      edge.tasks.push(task);
    }
    edges.set(key, edge);
  };
  const channels = new Map<string, MessageView[]>();
  for (const task of tasks) {
    channels.set(task.channel, [...(channels.get(task.channel) ?? []), task]);
    const node = `channel:${task.channel}`;
    const parent = byId.get(task.labels["factory.from"] ?? "");
    if (parent === undefined) {
      const source =
        task.labels["factory.schedule"] === undefined ? "people" : "schedule";
      sources.add(source);
      add(`source:${source}`, node, task.id);
    } else {
      add(`channel:${parent.channel}`, node, task.id);
    }
    const end = ENDS[task.task?.state ?? ""];
    if (end !== undefined && !(end === "done" && parents.has(task.id))) {
      ends.add(end);
      add(node, `end:${end}`, task.id);
    }
  }
  // A task can come from a channel that has no task of its own in the period.
  for (const key of edges.keys()) {
    const from = (key.split("\n")[0] ?? "").replace(CHANNEL_NODE, "");
    if (key.startsWith("channel:") && !channels.has(from)) {
      channels.set(from, []);
    }
  }
  const nodes: FlowNode[] = [
    ...[...sources].toSorted().map((source) => ({
      agents: [],
      id: `source:${source}`,
      kind: "source" as const,
      label: source,
      medianRunMs: null,
      open: 0,
      total: 0,
    })),
    ...[...channels].map(([path, list]) => ({
      agents: agents
        .filter((agent) => agent.enabled && consumes(agent, path))
        .map((agent) => agent.name),
      id: `channel:${path}`,
      kind: "channel" as const,
      label: path,
      medianRunMs: median(
        runs
          .filter((run) => run.channel === path && run.endedAt !== null)
          .map((run) => (run.endedAt as number) - run.startedAt)
      ),
      open: list.filter((task) => ENDS[task.task?.state ?? ""] === undefined)
        .length,
      total: list.length,
    })),
    ...["done", "failed", "canceled"]
      .filter((end) => ends.has(end))
      .map((end) => ({
        agents: [],
        id: `end:${end}`,
        kind: "end" as const,
        label: end,
        medianRunMs: null,
        open: 0,
        total: 0,
      })),
  ];
  return {
    edges: [...edges].map(([key, edge]) => {
      const [from, to] = key.split("\n") as [string, string];
      return { count: edge.count, from, tasks: edge.tasks, to };
    }),
    nodes,
  };
};

/** The flow of the tasks that were made since `since`. */
export const loadFlow = async (
  board: Board,
  runs: readonly Run[],
  agents: readonly Agent[],
  since: number
) => {
  const all: MessageView[] = [];
  let after: string | undefined;
  for (let page = 0; page < PAGES_MAX; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each page needs the cursor of the page before it.
    const result = await board.tasks.list({
      ...(after === undefined ? {} : { after }),
      limit: PAGE,
      state: "all",
    });
    all.push(...result.tasks.map((task) => task.message));
    if (result.tasks.length < PAGE || result.cursor === after) {
      break;
    }
    after = result.cursor;
  }
  return flowOf(
    all.filter((task) => Date.parse(task.createdAt) >= since),
    all,
    runs,
    agents
  );
};

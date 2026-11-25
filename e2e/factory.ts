import { type APIRequestContext, expect } from "@playwright/test";

/** What the tests share: the REST API of Factory as short calls, and waits for what agents do. */

export const BOARD = "/api/board";
export const FACTORY = "/api/factory";

/** A name that no earlier run of the tests used: the tests can run again on the same instance. */
export const unique = (name: string) =>
  `${name}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

export interface Answer {
  // biome-ignore lint/suspicious/noExplicitAny: the tests read the JSON of the API as it comes.
  readonly body: any;
  readonly status: number;
}

const answer = async (
  response: Awaited<ReturnType<APIRequestContext["get"]>>
): Promise<Answer> => ({
  body: await response.json().catch(() => null),
  status: response.status(),
});

export type Api = ReturnType<typeof api>;

export const api = (request: APIRequestContext) => ({
  del: async (path: string) => answer(await request.delete(path)),
  get: async (path: string, params?: Record<string, string | number>) =>
    answer(await request.get(path, params === undefined ? {} : { params })),
  post: async (
    path: string,
    data: unknown = {},
    headers?: Record<string, string>
  ) =>
    answer(
      await request.post(path, {
        data,
        ...(headers === undefined ? {} : { headers }),
      })
    ),
});

export interface Run {
  readonly agent: string;
  readonly id: string;
  readonly note: string | null;
  readonly state: string;
  readonly steps: number;
  readonly taskId: string;
  readonly tokens: number;
}

const ENDED = ["blocked", "done", "error", "failed", "lost", "stopped"];
const RUN_TIMEOUT_MS = 240_000;
const POLL_MS = [500, 1000, 2000];

/** The model of the test agents: `FACTORY_E2E_MODEL`, or one that the instance has credentials for. */
export const modelOf = async (factory: Api) => {
  const { models } = (await factory.get(FACTORY)).body as { models: string[] };
  expect(
    models.length,
    "The instance needs a model with credentials for the tests of the agents."
  ).toBeGreaterThan(0);
  return (
    process.env.FACTORY_E2E_MODEL ??
    models.find((model) => model.endsWith("gpt-5.6-sol")) ??
    (models[0] as string)
  );
};

/** Make a channel of the board. */
export const channel = async (factory: Api, path: string) => {
  expect(
    (await factory.post(`${BOARD}/channels`, { path })).status
  ).toBeLessThan(300);
  return path;
};

/** Make a task on the board. Answers its ID. */
export const task = async (
  factory: Api,
  where: string,
  text: string,
  labels?: Record<string, string>
) => {
  const made = await factory.post(`${BOARD}/tasks`, {
    channel: where,
    text,
    ...(labels === undefined ? {} : { labels }),
  });
  expect(made.status).toBeLessThan(300);
  return made.body.task.id as string;
};

/** The task of a thread as the board has it now. */
export const taskOf = async (factory: Api, id: string) => {
  const thread = (await factory.get(`${BOARD}/messages/${id}`)).body;
  return {
    labels: thread.message.labels as Record<string, string>,
    replies: thread.replies as {
      by: { actor: string };
      text: string;
    }[],
    task: thread.message.task as {
      blocked: { kind: string | null; reason: string } | null;
      reason: string | null;
      result: string | null;
      state: string;
    },
  };
};

/** The runs of a task, newest first. */
export const runsOf = async (factory: Api, taskId: string) =>
  (await factory.get(`${FACTORY}/runs`, { task: taskId })).body.runs as Run[];

/** Wait until the task has `count` runs and the newest of them is over. Answers that run. */
export const ended = async (factory: Api, taskId: string, count = 1) => {
  let last: Run | undefined;
  await expect
    .poll(
      async () => {
        const runs = await runsOf(factory, taskId);
        [last] = runs;
        return (
          runs.length >= count &&
          last !== undefined &&
          ENDED.includes(last.state)
        );
      },
      { intervals: POLL_MS, timeout: RUN_TIMEOUT_MS }
    )
    .toBe(true);
  return last as Run;
};

/** Wait until the newest run of the task has called the tool. Answers that run. */
export const calls = async (factory: Api, taskId: string, tool: string) => {
  let last: Run | undefined;
  await expect
    .poll(
      async () => {
        [last] = await runsOf(factory, taskId);
        if (last === undefined) {
          return false;
        }
        const { steps } = (await factory.get(`${FACTORY}/runs/${last.id}`))
          .body;
        return (steps as { tool: string }[]).some((step) => step.tool === tool);
      },
      { intervals: POLL_MS, timeout: RUN_TIMEOUT_MS }
    )
    .toBe(true);
  return last as Run;
};

/** Make an agent that does exactly what a task says. Answers the saved agent. */
export const agent = async (
  factory: Api,
  name: string,
  settings: Record<string, unknown>
) => {
  const saved = await factory.post(`${FACTORY}/agents`, {
    description: "Does small test tasks exactly as they say.",
    instructions:
      "Do exactly what the task says, with the fewest steps. Do not make other tasks, and do not ask questions, unless the task says so.",
    model: await modelOf(factory),
    name,
    thinking: "low",
    ...settings,
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return saved.body;
};

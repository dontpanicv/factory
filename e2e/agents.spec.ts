import { expect, test } from "@playwright/test";
import {
  type Api,
  api,
  BOARD,
  FACTORY,
  runsOf,
  taskOf,
  unique,
} from "./factory.ts";

/** The definitions of agents and their schedules. The work of agents is in `work.spec.ts`. */

test.describe.configure({ mode: "serial" });

const name = unique("e2e-agent");
const room = unique("e2e-agents");

const overviewOf = async (factory: Api) =>
  (await factory.get(FACTORY)).body.agents.find(
    (one: { name: string }) => one.name === name
  );

test("an agent is saved with its defaults", async ({ request }) => {
  const saved = await api(request).post(`${FACTORY}/agents`, { name });
  expect(saved.status).toBe(200);
  expect(saved.body).toEqual({
    channels: [],
    description: "",
    enabled: true,
    image: "",
    instructions: "",
    maxTurns: 80,
    model: "",
    name,
    parallel: 1,
    projects: [],
    resources: [],
    schedules: [],
    secrets: [],
    skills: [],
    thinking: "medium",
  });
});

test("an agent with a bad name, schedule or limit is refused", async ({
  request,
}) => {
  const factory = api(request);
  const schedule = { channel: room, cron: "0 8 * * *", text: "Check" };
  for (const body of [
    { name: "Bad Name" },
    { name: "" },
    { name, schedules: [{ ...schedule, cron: "every morning" }] },
    { name, schedules: [{ ...schedule, cron: "61 8 * * *" }] },
    { name, schedules: [{ ...schedule, zone: "Mars/Olympus" }] },
    { name, parallel: 0 },
    { maxTurns: 1.5, name },
    { channels: "not-a-list", name },
  ]) {
    const answer = await factory.post(`${FACTORY}/agents`, body);
    expect(answer.status, JSON.stringify(body)).toBe(400);
    expect(answer.body.error.code).toBe("invalid");
  }
  // The refused changes did not change the agent.
  expect((await overviewOf(factory)).schedules).toEqual([]);
});

test("the overview has the agent with its runs and the next time of its schedule", async ({
  request,
}) => {
  const factory = api(request);
  await factory.post(`${FACTORY}/agents`, {
    channels: [`${room}/`],
    description: "Checks things.",
    // It takes no task: these tests are about its definition.
    enabled: false,
    name,
    schedules: [
      {
        channel: `${room}/checks`,
        cron: "0 8 * * *",
        text: "Morning check\nLook at the logs.",
        zone: "Europe/Prague",
      },
    ],
  });
  await expect
    .poll(async () => (await overviewOf(factory)).next[0])
    .toBeGreaterThan(Date.now());
  const agent = await overviewOf(factory);
  expect(agent.last).toBeNull();
  expect(agent.live).toEqual([]);
  expect(agent.channels).toEqual([`${room}/`]);
  // 08:00 in Prague is 06:00 or 07:00 in UTC.
  expect([6, 7]).toContain(new Date(agent.next[0]).getUTCHours());
  expect(new Date(agent.next[0]).getUTCMinutes()).toBe(0);
});

test("a schedule makes its task now, for its agent, and an agent that is off does not take it", async ({
  request,
}) => {
  const factory = api(request);
  const fired = await factory.post(`${FACTORY}/agents/${name}/schedules/0`);
  expect(fired.status).toBe(200);
  const made = await taskOf(factory, fired.body.task);
  expect(made.labels["factory.agent"]).toBe(name);
  expect(made.labels["factory.schedule"]).toBe("1");
  // The schedule made its channel.
  const channels = (await factory.get(`${BOARD}/channels`)).body.channels.map(
    (one: { path: string }) => one.path
  );
  expect(channels).toContain(`${room}/checks`);
  const thread = (await factory.get(`${BOARD}/messages/${fired.body.task}`))
    .body.message;
  expect(thread.text).toBe("Morning check\nLook at the logs.");
  expect(thread.by.actor).toBe("board:client:schedule");
  // The agent is off: the task stays on the board.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  expect((await taskOf(factory, fired.body.task)).task.state).toBe("ready");
  expect(await runsOf(factory, fired.body.task)).toEqual([]);
  await factory.post(`${BOARD}/tasks/${fired.body.task}/cancel`, {
    reason: "Cleanup",
  });
  for (const path of [`${name}/schedules/7`, "no-such-agent/schedules/0"]) {
    expect((await factory.post(`${FACTORY}/agents/${path}`)).status).toBe(400);
  }
});

test("the runs of an agent without work are an empty list, and the agent is removed", async ({
  request,
}) => {
  const factory = api(request);
  const runs = await factory.get(`${FACTORY}/runs`, { agent: name });
  expect(runs.body).toEqual({ runs: [] });
  expect((await factory.del(`${FACTORY}/agents/${name}`)).status).toBe(200);
  expect(await overviewOf(factory)).toBeUndefined();
});

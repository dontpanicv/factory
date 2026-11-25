import { expect, test } from "@playwright/test";
import {
  agent,
  api,
  BOARD,
  calls,
  channel,
  ended,
  FACTORY,
  runsOf,
  task,
  taskOf,
  unique,
} from "./factory.ts";

/**
 * Agents at work: an agent takes a task of its channel, works in a sandbox with a model, and
 * writes the result to the board. These tests need Docker and a model with credentials.
 */

test.describe.configure({ mode: "serial" });

const room = unique("e2e-work");
const inbox = `${room}/in`;
const outbox = `${room}/out`;
const worker = unique("e2e-worker");
const secret = `E2E_WORD_${Date.now()}`;
const cache = unique("e2e-cache");
const project = unique("e2e-repo");
const skill = unique("e2e-skill");

test.beforeAll(async ({ request }) => {
  const factory = api(request);
  await channel(factory, inbox);
  await channel(factory, outbox);
  await factory.post(`${FACTORY}/secrets`, { name: secret, value: "bluebird" });
  await factory.post(`${FACTORY}/resources`, {
    description: "A Redis on port 6379.",
    image: "redis:7-alpine",
    name: cache,
  });
  await factory.post(`${FACTORY}/projects`, {
    name: project,
    url: "https://github.com/dontpanicv/factory.git",
  });
  await factory.post(`${FACTORY}/skills`, {
    body: "The password of the day is plum.",
    description: "Use it when a task asks for the password of the day.",
    name: skill,
  });
  await agent(factory, worker, {
    channels: [inbox],
    resources: [cache],
    secrets: [secret],
  });
});

test.afterAll(async ({ request }) => {
  const factory = api(request);
  await factory.del(`${FACTORY}/agents/${worker}`);
  await factory.del(`${FACTORY}/resources/${cache}`);
  await factory.del(`${FACTORY}/projects/${project}`);
  await factory.del(`${FACTORY}/skills/${skill}`);
  await factory.del(`${FACTORY}/secrets/${secret}`);
});

test("an agent does a task in its sandbox, with its secret and its shared resource", async ({
  request,
}) => {
  const factory = api(request);
  const id = await task(
    factory,
    inbox,
    [
      "Word and cache",
      `Run this with bash: echo "$${secret}" && timeout 3 bash -c 'exec 3<>/dev/tcp/${cache}/6379 && echo PING >&3 && head -c 5 <&3'`,
      "Answer in the first line with the two lines of the output, with a space between them.",
    ].join("\n")
  );
  const run = await ended(factory, id);
  expect(run.state, run.note ?? "").toBe("done");
  expect(run.agent).toBe(worker);
  expect(run.steps).toBeGreaterThan(0);
  expect(run.tokens).toBeGreaterThan(0);
  // The board has the result, from the agent as its own actor.
  const now = await taskOf(factory, id);
  expect(now.task.state).toBe("completed");
  expect(now.task.result).toContain("bluebird");
  expect(now.task.result).toContain("PONG");
  expect(now.replies.at(-1)?.by.actor).toBe(`board:client:${worker}`);
  // The log of the run has each step with its output, and no claim on the task.
  const log = (await factory.get(`${FACTORY}/runs/${run.id}`)).body;
  const bash = log.steps.find((step: { tool: string }) => step.tool === "bash");
  expect(bash.output).toContain("bluebird");
  expect(bash.failed).toBe(false);
  expect(log.steps.at(-1).kind).toBe("say");
  expect(JSON.stringify(log)).not.toContain('"claim"');
  // The overview has the run as the last of the agent.
  const overview = (await factory.get(FACTORY)).body;
  const mine = overview.agents.find(
    (one: { name: string }) => one.name === worker
  );
  expect(mine.last.id).toBe(run.id);
  expect(mine.live).toEqual([]);
  // The agent's run started the shared resource.
  expect(
    overview.resources.find((one: { name: string }) => one.name === cache).state
  ).toBe("running");
});

test("the sandbox has the agent's repository, and the agent reads its AGENTS.md and its skill", async ({
  request,
}) => {
  const factory = api(request);
  const reader = unique("e2e-reader");
  const desk = await channel(factory, `${room}/read`);
  await agent(factory, reader, {
    channels: [desk],
    projects: [project],
    skills: [skill],
  });
  const id = await task(
    factory,
    desk,
    [
      "Repository and skill",
      "Run `pwd && git rev-parse --abbrev-ref HEAD` with bash.",
      `Answer in the first line with: the output of pwd, the branch, the first heading of the AGENTS.md of the repository as your instructions have it, and the password of the day from your skill ${skill}.`,
    ].join("\n")
  );
  const run = await ended(factory, id);
  expect(run.state, run.note ?? "").toBe("done");
  const { result } = (await taskOf(factory, id)).task;
  expect(result).toContain(`/workspace/${project}`);
  expect(result).toContain("main");
  expect(result).toContain("Factory Agent Guidance");
  expect(result).toContain("plum");
  await factory.del(`${FACTORY}/agents/${reader}`);
});

test("an agent hands work to a different channel, and the flow has that way", async ({
  request,
}) => {
  const factory = api(request);
  const id = await task(
    factory,
    inbox,
    `Hand over\nMake a task in #${outbox} with the text "Handed over" with board_task. Then answer: sent`
  );
  expect((await ended(factory, id)).state).toBe("done");
  const made = (
    await factory.get(`${BOARD}/tasks`, { channel: outbox, state: "all" })
  ).body.tasks[0].message;
  expect(made.text).toContain("Handed over");
  expect(made.labels["factory.from"]).toBe(id);
  expect(made.labels["factory.depth"]).toBe("1");
  expect(made.by.actor).toBe(`board:client:${worker}`);
  const flow = (await factory.get(`${FACTORY}/flow`, { days: 1 })).body;
  const way = flow.edges.find(
    (edge: { from: string; to: string }) =>
      edge.from === `channel:${inbox}` && edge.to === `channel:${outbox}`
  );
  expect(way.count).toBe(1);
  expect(way.tasks).toEqual([made.id]);
  const node = flow.nodes.find(
    (one: { id: string }) => one.id === `channel:${inbox}`
  );
  expect(node.agents).toEqual([worker]);
  expect(node.medianRunMs).toBeGreaterThan(0);
  await factory.post(`${BOARD}/tasks/${made.id}/cancel`, { reason: "Cleanup" });
});

test("a chain of tasks that agents make stops at its limit", async ({
  request,
}) => {
  const factory = api(request);
  const id = await task(
    factory,
    inbox,
    `End of a chain\nMake a task in #${outbox} with the text "One too many" with board_task. When the tool refuses, answer: refused`,
    { "factory.depth": "12" }
  );
  const run = await ended(factory, id);
  const { steps } = (await factory.get(`${FACTORY}/runs/${run.id}`)).body;
  const refused = steps.find(
    (step: { tool: string }) => step.tool === "board_task"
  );
  expect(refused.failed).toBe(true);
  expect(refused.output).toContain("A chain stops at 12");
  const there = (
    await factory.get(`${BOARD}/tasks`, { channel: outbox, state: "open" })
  ).body.tasks;
  expect(there).toEqual([]);
});

test("an agent gives its task to a person, and goes on when the person answers", async ({
  request,
}) => {
  const factory = api(request);
  const id = await task(
    factory,
    inbox,
    "A question\nCall task_block with the question: Which colour? When the task comes back to you, answer in the first line with the colour that the person gave."
  );
  const first = await ended(factory, id);
  expect(first.state).toBe("blocked");
  expect(first.note).toContain("Which colour?");
  const waiting = await taskOf(factory, id);
  expect(waiting.task.state).toBe("blocked");
  expect(waiting.task.blocked).toEqual({
    kind: "needs_input",
    reason: "Which colour?",
  });
  await factory.post(`${BOARD}/messages`, { re: id, text: "Use green." });
  await factory.post(`${BOARD}/tasks/${id}/unblock`);
  const second = await ended(factory, id, 2);
  expect(second.state, second.note ?? "").toBe("done");
  expect(second.id).not.toBe(first.id);
  const done = await taskOf(factory, id);
  expect(done.task.state).toBe("completed");
  expect(done.task.result?.toLowerCase()).toContain("green");
});

test("an agent says that a task cannot be done", async ({ request }) => {
  const factory = api(request);
  const id = await task(
    factory,
    inbox,
    "Not possible\nCall task_fail with the reason: It is not possible."
  );
  const run = await ended(factory, id);
  expect(run.state).toBe("failed");
  const now = await taskOf(factory, id);
  expect(now.task.state).toBe("failed");
  expect(now.task.reason).toContain("not possible");
});

test("a person stops a run, and the task waits for a person", async ({
  request,
}) => {
  const factory = api(request);
  const id = await task(
    factory,
    inbox,
    "A long sleep\nRun `sleep 120 && echo awake` with bash, then answer with its output."
  );
  const live = await calls(factory, id, "bash");
  expect((await factory.post(`${FACTORY}/runs/${live.id}/stop`)).status).toBe(
    200
  );
  const run = await ended(factory, id);
  expect(run.state).toBe("stopped");
  expect(run.note).toContain("Stopped by");
  const now = await taskOf(factory, id);
  expect(now.task.state).toBe("blocked");
  expect(now.task.blocked?.kind).toBe("stopped");
  await factory.post(`${BOARD}/tasks/${id}/cancel`, { reason: "Cleanup" });
});

test("a run ends when a person cancels its task", async ({ request }) => {
  const factory = api(request);
  const id = await task(
    factory,
    inbox,
    "Another long sleep\nRun `sleep 150 && echo awake` with bash, then answer with its output."
  );
  await calls(factory, id, "bash");
  await factory.post(`${BOARD}/tasks/${id}/cancel`, { reason: "Not needed" });
  const run = await ended(factory, id);
  expect(run.state).toBe("lost");
  expect((await taskOf(factory, id)).task.state).toBe("canceled");
});

test("a run that uses all its tool rounds fails its task with a clear reason", async ({
  request,
}) => {
  const factory = api(request);
  const short = unique("e2e-short");
  const desk = await channel(factory, `${room}/short`);
  await agent(factory, short, { channels: [desk], maxTurns: 1 });
  const id = await task(
    factory,
    desk,
    "Two steps\nFirst run `echo one` with bash. After you see its output, run `echo two` with bash in a second call. Then answer with both outputs."
  );
  const run = await ended(factory, id);
  expect(run.state).toBe("error");
  expect(run.note).toContain("tool rounds");
  const now = await taskOf(factory, id);
  expect(now.task.state).toBe("failed");
  expect(now.replies.at(-1)?.text).toContain("The run stopped");
  await factory.del(`${FACTORY}/agents/${short}`);
});

test("an agent does two tasks at one time when it may", async ({ request }) => {
  const factory = api(request);
  const pair = unique("e2e-pair");
  const desk = await channel(factory, `${room}/pair`);
  await agent(factory, pair, { channels: [desk], parallel: 2 });
  const ids = await Promise.all(
    ["a", "b"].map((word) =>
      task(
        factory,
        desk,
        `Sleep ${word}\nRun \`sleep 20 && echo ${word}\` with bash, then answer with its output.`
      )
    )
  );
  await expect
    .poll(
      async () =>
        (await factory.get(FACTORY)).body.agents.find(
          (one: { name: string }) => one.name === pair
        ).live.length,
      { timeout: 60_000 }
    )
    .toBe(2);
  for (const id of ids) {
    expect((await ended(factory, id)).state).toBe("done");
  }
  await factory.del(`${FACTORY}/agents/${pair}`);
});

test("a task with the label of an agent is for that agent, in any channel", async ({
  request,
}) => {
  const factory = api(request);
  const elsewhere = await channel(factory, `${room}/elsewhere`);
  const id = await task(
    factory,
    elsewhere,
    "For one agent\nAnswer with the one word: hello",
    { "factory.agent": worker }
  );
  const run = await ended(factory, id);
  expect(run.state).toBe("done");
  expect(run.agent).toBe(worker);
  expect(await runsOf(factory, id)).toHaveLength(1);
});

test("an image without bash or git fails the task with a clear reason", async ({
  request,
}) => {
  const factory = api(request);
  const bare = unique("e2e-bare");
  const desk = await channel(factory, `${room}/bare`);
  await agent(factory, bare, { channels: [desk], image: "alpine:3" });
  const id = await task(
    factory,
    desk,
    "Hello\nAnswer with the one word: hello"
  );
  const run = await ended(factory, id);
  expect(run.state).toBe("error");
  expect(run.note).toContain("no bash or no git");
  expect((await taskOf(factory, id)).task.state).toBe("failed");
  await factory.del(`${FACTORY}/agents/${bare}`);
});

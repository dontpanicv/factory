import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { localDaemon } from "@earendil-works/pi-env";
import { makeBoard } from "../src/server/board.ts";
import { FACTORY_SCHEMA } from "../src/server/db.ts";
import { startRunner } from "../src/server/factory/runner.ts";
import type { SandboxProvider } from "../src/server/factory/sandbox.ts";
import { consumes, nextRun, Store } from "../src/server/factory/store.ts";

/** Boxes as directories on this computer, each with the pi-env daemon of this computer: no Docker. */
const directories = (root: string, started: string[]): SandboxProvider => ({
  boxes: () => Promise.resolve([]),
  kind: "directories",
  resourceDown: () => Promise.resolve(),
  resourceStates: () => Promise.resolve({}),
  resourceUp: (spec) => {
    started.push(`resource ${spec.name}`);
    return Promise.resolve();
  },
  start: (spec) => {
    const workspace = join(root, spec.id);
    mkdirSync(workspace, { recursive: true });
    started.push(`box ${Object.keys(spec.env).join(",")}`);
    return Promise.resolve({ daemon: [localDaemon()], id: spec.id, workspace });
  },
  stop: () => Promise.resolve(),
});

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-test-"));
  const { team } = makeBoard({
    currentUser: () => Promise.resolve(null),
    dir: null,
    url: "http://localhost:4310/api/board",
  });
  const store = new Store(":memory:");
  store.createTables(FACTORY_SCHEMA);
  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  const started: string[] = [];
  const runner = await startRunner({
    board: team,
    file: null,
    models,
    provider: directories(root, started),
    store,
  });
  return { faux, root, runner, started, store, team };
};

const MODEL = "faux/faux-1";

/** A model turn that calls one tool. */
const call = (name: string, args: Record<string, string>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

test("an agent takes a task of its channel, works in its box, answers, and hands work on", async () => {
  const { faux, root, runner, started, store, team } = await setup();
  // A repository with a skill and its AGENTS.md, as a local Git repository.
  const origin = join(root, "origin");
  mkdirSync(join(origin, ".agents/skills/release"), { recursive: true });
  writeFileSync(join(origin, "AGENTS.md"), "Always run the tests.\n");
  writeFileSync(
    join(origin, ".agents/skills/release/SKILL.md"),
    "---\nname: release\ndescription: How to release\n---\nTag it.\n"
  );
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "."],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"],
  ]) {
    Bun.spawnSync(["git", ...args], { cwd: origin });
  }
  store.setSecret("API_TOKEN", "s3cret");
  store.put("projects", { name: "app", url: origin });
  store.put("skills", {
    body: "Look at the logs.",
    description: "How to triage",
    name: "triage",
  });
  store.put("resources", { image: "postgres:17", name: "db" });
  store.put("agents", {
    channels: ["ops/"],
    description: "Finds problems.",
    model: MODEL,
    name: "sre",
    projects: ["app"],
    resources: ["db"],
    secrets: ["API_TOKEN"],
    skills: ["triage"],
  });
  await team.createChannel("ops/alerts");
  await team.createChannel("dev");
  let prompt = "";
  faux.setResponses([
    (transcript) => {
      prompt = JSON.stringify(transcript);
      return call("bash", { command: "echo $API_TOKEN > note.txt && ls app" });
    },
    call("board_task", { channel: "dev", text: "Fix the leak\nIt leaks." }),
    fauxAssistantMessage([
      fauxText("Found a leak.\nA task for it is in #dev."),
    ]),
  ]);
  const { task } = await team.tasks.create("ops/alerts", "Check the logs");
  await runner.tick();
  await runner.whenIdle();

  const [run] = store.runs({ task: task.id });
  expect(run?.state).toBe("done");
  expect(run?.agent).toBe("sre");
  expect(run?.steps).toBe(2);
  // The brain got the role, the repository's instructions and both skills.
  expect(prompt).toContain("Finds problems.");
  expect(prompt).toContain("Always run the tests.");
  expect(prompt).toContain("triage: How to triage");
  expect(prompt).toContain("release: How to release");
  // The hands ran in the box, with the secret and the checkout.
  expect(started).toEqual(["resource db", "box API_TOKEN"]);
  const steps = await runner.steps(run as NonNullable<typeof run>);
  expect(steps[0]?.tool).toBe("bash");
  expect(steps[0]?.output).toContain("AGENTS.md");
  // The board shows the result, and the new task says where it came from.
  const thread = await team.thread(task.id);
  expect(thread.message.task?.state).toBe("completed");
  expect(thread.message.task?.result).toBe("Found a leak.");
  expect(thread.replies.at(-1)?.by.actor).toContain("sre");
  const handed = (await team.tasks.list({ channel: "dev" })).tasks[0]?.message;
  expect(handed?.labels["factory.from"]).toBe(task.id);
  expect(handed?.task?.state).toBe("ready");
  await runner.close();
});

test("an agent gives its task to a person, and a model error fails the task", async () => {
  const { faux, runner, store, team } = await setup();
  store.put("agents", { channels: ["dev"], model: MODEL, name: "dev" });
  await team.createChannel("dev");
  faux.setResponses([
    call("task_block", { question: "Which branch?" }),
    fauxAssistantMessage("", {
      errorMessage: "no credit",
      stopReason: "error",
    }),
    fauxAssistantMessage("", {
      errorMessage: "no credit",
      stopReason: "error",
    }),
    fauxAssistantMessage("", {
      errorMessage: "no credit",
      stopReason: "error",
    }),
    fauxAssistantMessage("", {
      errorMessage: "no credit",
      stopReason: "error",
    }),
  ]);
  const first = await team.tasks.create("dev", "Release it");
  await runner.tick();
  await runner.whenIdle();
  expect(store.runs({ task: first.task.id })[0]?.state).toBe("blocked");
  const blocked = (await team.thread(first.task.id)).message.task;
  expect(blocked?.state).toBe("blocked");
  expect(blocked?.blocked?.reason).toBe("Which branch?");

  const second = await team.tasks.create("dev", "Fix it");
  await runner.tick();
  await runner.whenIdle();
  const [run] = store.runs({ task: second.task.id });
  expect(run?.state).toBe("error");
  expect(run?.note).toContain("no credit");
  expect((await team.thread(second.task.id)).message.task?.state).toBe(
    "failed"
  );
  await runner.close();
}, 30_000);

test("a schedule makes a task for its agent, and channels match by prefix", async () => {
  const { runner, store, team } = await setup();
  const agent = store.put("agents", {
    enabled: false,
    name: "sre",
    schedules: [
      {
        channel: "ops/checks",
        cron: "0 8 * * *",
        text: "Check the logs",
        zone: "Europe/Prague",
      },
    ],
  });
  const id = await runner.runNow("sre", 0);
  const made = (await team.thread(id)).message;
  expect(made.channel).toBe("ops/checks");
  expect(made.labels["factory.agent"]).toBe("sre");
  // 08:00 in Prague is 07:00 UTC in winter and 06:00 UTC in summer.
  expect(
    nextRun(
      agent.schedules[0] as never,
      new Date("2026-01-10T12:00:00Z")
    )?.toISOString()
  ).toBe("2026-01-11T07:00:00.000Z");
  expect(
    nextRun(
      agent.schedules[0] as never,
      new Date("2026-07-10T12:00:00Z")
    )?.toISOString()
  ).toBe("2026-07-11T06:00:00.000Z");
  expect(() =>
    store.put("agents", {
      name: "x",
      schedules: [{ channel: "a", cron: "nope", text: "t" }],
    })
  ).toThrow();
  const pipes = { ...agent, channels: ["pipes/", "dev"] };
  expect(consumes(pipes, "pipes")).toBe(true);
  expect(consumes(pipes, "pipes/review")).toBe(true);
  expect(consumes(pipes, "pipesx")).toBe(false);
  expect(consumes(pipes, "dev")).toBe(true);
  expect(consumes(pipes, "dev/x")).toBe(false);
  await runner.close();
});

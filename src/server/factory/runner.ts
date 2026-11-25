import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  type Conversation,
  createRegistry,
  Harness,
  MemoryStorage,
  type Submission,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createFitImagesExtension } from "@earendil-works/pi-durable/images/fit";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import type { Board } from "@vercel/board";
import { threadText } from "./prompt.ts";
import type { SandboxProvider } from "./sandbox.ts";
import {
  type Agent,
  consumes,
  nextRun,
  type Run,
  type RunState,
  resourceSpec,
  type Store,
} from "./store.ts";
import { boardTools, type RunContext } from "./tools.ts";
import {
  entriesOf,
  type Step,
  spentOf,
  stepsOf,
  textOf,
} from "./transcript.ts";
import { prepare } from "./workspace.ts";

/**
 * The agents at work. The runner gives each ready task of the board to an agent of its channel:
 * the agent claims the task, gets a sandbox, and works as a Pi Durable conversation in this
 * process (the brain) with its tools in the sandbox (the hands). It also makes the tasks of the
 * schedules. A restart of Factory continues the runs that it cut off.
 */

const context = BACKGROUND_CONTEXT;
/** An agent holds its task this long without a renewal. A run that dies frees its task after it. */
const LEASE_SECONDS = 180;
const RENEW_MS = 60_000;
/** The schedules, and the tasks that no event announced, are checked this often. */
const TICK_MS = 20_000;
const EVENT_SETTLE_MS = 250;
const THREAD_LIMIT = 200;
const RESULT_MAX = 200;
const LIVE_MAX = 1000;
/** What an agent reads first when a task that it gave to a person comes back to it. */
const CONTINUED =
  "The task continues: a person gave it back to you. Your sandbox is new: the repositories are fresh checkouts, and files that you did not push are gone. This is the task with its thread as it is now.";
/** The states of a run after which the same agent goes on in the same conversation. */
const GIVEN_BACK: readonly RunState[] = ["blocked", "stopped"];

export interface Runner {
  readonly close: () => Promise<void>;
  /** The next time of each schedule: `agent|index` to epoch milliseconds. */
  readonly nextRuns: () => Record<string, number>;
  /** Make the task of a schedule now. Answers the task's ID. */
  readonly runNow: (agent: string, index: number) => Promise<string>;
  readonly steps: (run: Run) => Promise<Step[]>;
  /** Stop a run: its task then waits for a person. */
  readonly stop: (id: string, by: string) => Promise<void>;
  /** Fire the schedules that are due and give the ready tasks to agents. */
  readonly tick: () => Promise<void>;
  /** Resolves when no run works (tests). */
  readonly whenIdle: () => Promise<void>;
}

type Held = RunContext["held"];

/** A run that works in this process. */
interface Live {
  connection: Connection | null;
  conversation: Conversation | null;
  readonly done: Promise<void>;
  /** The claim ended: someone else finished or canceled the task. */
  lost: boolean;
  /** Who stopped it. */
  stoppedBy: string | null;
  timer: ReturnType<typeof setInterval> | null;
}

const firstLine = (text: string) =>
  (text.trim().split("\n")[0] ?? "").slice(0, RESULT_MAX);

const modelOf = (agent: Agent) => {
  const slash = agent.model.indexOf("/");
  return {
    modelId: agent.model.slice(slash + 1),
    provider: agent.model.slice(0, slash),
  };
};

export const startRunner = async (options: {
  readonly board: Board;
  /** Pi Durable's file, or null to keep the conversations in memory (tests). */
  readonly file: string | null;
  readonly log?: (message: string) => void;
  readonly models: Models;
  readonly provider: SandboxProvider;
  readonly store: Store;
}): Promise<Runner> => {
  const { board, provider, store } = options;
  const log = options.log ?? (() => undefined);
  const live = new Map<string, Live>();
  const contexts = new Map<number, RunContext>();
  const envs = new Map<number, ExecutionEnv>();
  const registry = createRegistry();
  // As in the Pi coding agent: `read` turns an image upright and makes it fit the model.
  const images = await createNodePhotonImages();
  registry.install(createCodingTools({ images }));
  registry.install(createFitImagesExtension(images));
  registry.install(boardTools((id) => contexts.get(id)));
  const harness = await Harness.open(
    options.file === null
      ? new MemoryStorage()
      : await openNodeSqliteStorage(options.file),
    {
      env: ({ conversationId }) => envs.get(conversationId),
      models: options.models,
      registry,
      // The defaults of the Pi coding agent (pi's `settings-defaults.ts`).
      settings: {
        compaction: {
          enabled: true,
          keepRecentTokens: 20_000,
          reserveTokens: 16_384,
        },
        retry: { maxRetries: 3 },
      },
    },
    context
  );

  const end = (id: string, state: RunState, note: string) => {
    store.updateRun(id, { endedAt: Date.now(), note, state });
    log(`run ${id}: ${state}${note === "" ? "" : ` (${note})`}`);
  };

  /** The agent's box, with the shared resources that it can reach. */
  const openBox = async (agent: Agent, run: Run, entry: Live) => {
    const resources = agent.resources.flatMap(
      (name) => store.get("resources", name) ?? []
    );
    await Promise.all(
      resources.map((resource) =>
        provider.resourceUp(resourceSpec(resource, store))
      )
    );
    const box = await provider.start({
      env: store.secrets([
        ...agent.secrets,
        ...agent.projects.flatMap(
          (name) => store.get("projects", name)?.tokenSecret || []
        ),
      ]),
      id: run.id,
      image: agent.image,
      resources: resources.map((resource) => resource.name),
    });
    const connection = new Connection({ command: box.daemon });
    entry.connection = connection;
    return new RemoteExecutionEnv({
      connection,
      cwd: box.workspace,
      id: `box:${run.id}`,
    });
  };

  /** A new conversation with the task as its input, or the one that a restart cut off. */
  const openConversation = async (
    agent: Agent,
    run: Run,
    env: RemoteExecutionEnv,
    runContext: RunContext
  ): Promise<{ conversation: Conversation; submission: Submission }> => {
    if (run.conversationId !== null && run.submissionId !== null) {
      const conversation = await harness.conversation(
        run.conversationId as never,
        context
      );
      const submission = await harness.submission(
        run.submissionId as never,
        context
      );
      if (conversation === undefined || submission === undefined) {
        throw new Error("The conversation of the run is not in storage.");
      }
      env.cwd = (await conversation.agent(context)).cwd ?? env.cwd;
      contexts.set(conversation.id, runContext);
      envs.set(conversation.id, env);
      harness.resume();
      return { conversation, submission };
    }
    const { cwd, instructions } = await prepare({
      agent,
      board,
      env,
      store,
      workspace: env.cwd,
    });
    env.cwd = cwd;
    const thread = await runContext.me.thread(run.taskId, {
      limit: THREAD_LIMIT,
    });
    const settings = {
      cwd,
      instructions,
      maxTurns: agent.maxTurns,
      model: modelOf(agent),
      ...(agent.thinking === ""
        ? {}
        : { thinkingLevel: agent.thinking as never }),
    };
    // A task that a person gave back goes on in the conversation that the agent had: it knows what it did.
    const kept =
      run.conversationId === null
        ? undefined
        : await harness.conversation(run.conversationId as never, context);
    const conversation =
      kept ??
      (await harness.createConversation(
        { agent: settings, ownership: { kind: "ownerless" } },
        context
      ));
    if (kept !== undefined) {
      await kept.configure(settings, context);
    }
    contexts.set(conversation.id, runContext);
    envs.set(conversation.id, env);
    const submission = await conversation.submit(
      {
        content:
          kept === undefined
            ? threadText(thread)
            : `${CONTINUED}\n\n${threadText(thread)}`,
        requestId: run.id,
        type: "input",
      },
      context
    );
    store.updateRun(run.id, {
      conversationId: conversation.id,
      state: "running",
      submissionId: submission.id,
    });
    return { conversation, submission };
  };

  /** Write the end of a run to the board and to the store. */
  const conclude = async (
    run: Run,
    entry: Live,
    runContext: RunContext,
    conversation: Conversation,
    settled: Awaited<ReturnType<Submission["wait"]>>
  ) => {
    const { held, me } = runContext;
    const entries = await entriesOf(conversation, context);
    store.updateRun(run.id, spentOf(entries));
    if (entry.lost) {
      end(run.id, "lost", "The task was finished or canceled by someone else.");
      return;
    }
    if (entry.stoppedBy !== null) {
      const note = `Stopped by ${entry.stoppedBy}.`;
      await held.block(note, { kind: "stopped" });
      end(run.id, "stopped", note);
      return;
    }
    if (runContext.outcome !== null) {
      end(run.id, runContext.outcome.state, runContext.outcome.note);
      return;
    }
    if (settled.status === "done" && settled.type === "input") {
      const answer = textOf(
        await conversation.commit(
          (tx) => tx.entry(AssistantEntry, settled.answer),
          context
        )
      );
      if (answer !== "") {
        await me.reply(run.taskId, answer);
      }
      await held.complete(firstLine(answer) || undefined);
      end(run.id, "done", firstLine(answer));
      return;
    }
    const reason =
      stepsOf(entries)
        .filter((step) => step.failed && step.kind === "say")
        .at(-1)?.text ??
      `The agent stopped without an answer (${"reason" in settled ? settled.reason : "unknown"}).`;
    await me.reply(run.taskId, `The run stopped: ${reason}`);
    await held.fail(firstLine(reason));
    end(run.id, "error", reason);
  };

  const drive = async (run: Run, entry: Live) => {
    const agent = store.get("agents", run.agent);
    if (agent === null || run.claim === null) {
      end(run.id, "error", "The agent is not defined any more.");
      return;
    }
    const me = board.as(agent.name);
    const held: Held = me.tasks.held(run.taskId, run.claim);
    const runContext: RunContext = {
      held,
      me,
      outcome: null,
      taskId: run.taskId,
    };
    const renew = async () => {
      try {
        await held.renew(LEASE_SECONDS);
      } catch (error) {
        if (
          (error as { code?: string }).code === "claim_lost" &&
          runContext.outcome === null
        ) {
          entry.lost = true;
          await entry.conversation?.abort(context);
        }
      }
    };
    entry.timer = setInterval(renew, RENEW_MS);
    try {
      if (agent.model === "") {
        throw new Error("The agent has no model. Set one on the agent's page.");
      }
      const env = await openBox(agent, run, entry);
      const { conversation, submission } = await openConversation(
        agent,
        run,
        env,
        runContext
      );
      entry.conversation = conversation;
      if (entry.stoppedBy !== null || entry.lost) {
        // It was stopped while the sandbox started.
        await conversation.abort(context);
      }
      const settled = await submission.wait(context);
      await conclude(run, entry, runContext, conversation, settled);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      end(run.id, "error", reason);
      // The task goes to a person: a new claim of the same agent would only fail again.
      try {
        await me.reply(run.taskId, `The run could not work: ${reason}`);
        await held.fail(firstLine(reason));
      } catch {
        // The claim is over: the board has the task's state.
      }
    }
  };

  const launch = (run: Run) => {
    let finished: () => void = () => undefined;
    const entry: Live = {
      connection: null,
      conversation: null,
      done: new Promise<void>((resolve) => {
        finished = resolve;
      }),
      lost: false,
      stoppedBy: null,
      timer: null,
    };
    live.set(run.id, entry);
    const work = async () => {
      try {
        await drive(run, entry);
      } catch (error) {
        end(run.id, "error", String(error));
      }
      if (entry.timer !== null) {
        clearInterval(entry.timer);
      }
      if (entry.conversation !== null) {
        contexts.delete(entry.conversation.id);
        envs.delete(entry.conversation.id);
      }
      entry.connection?.close();
      try {
        await provider.stop(run.id);
      } catch {
        // The start of the runner removes a box that stays.
      }
      live.delete(run.id);
      finished();
      tick();
    };
    work();
  };

  /** The conversation of the agent's last run of the task, when a person gave the task back. */
  const keptOf = (agent: string, task: string) => {
    const [before] = store.runs({ agent, task }, 1);
    return before !== undefined && GIVEN_BACK.includes(before.state)
      ? before.conversationId
      : null;
  };

  /** Give the ready tasks to the agents that do their channels and have time. */
  const assign = async () => {
    const agents = store.list("agents").filter((agent) => agent.enabled);
    if (agents.length === 0) {
      return;
    }
    const busy = new Map<string, number>();
    for (const run of store.runs({ live: true }, LIVE_MAX)) {
      busy.set(run.agent, (busy.get(run.agent) ?? 0) + 1);
    }
    const page = await board.tasks.list({ limit: 100, state: "ready" });
    for (const { message } of page.tasks) {
      // A task with the label `factory.agent` is for that agent, in any channel.
      const wanted = message.labels["factory.agent"];
      const agent = agents.find(
        (candidate) =>
          (wanted === undefined
            ? consumes(candidate, message.channel)
            : candidate.name === wanted) &&
          (busy.get(candidate.name) ?? 0) < candidate.parallel
      );
      if (agent === undefined) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: a claim changes which agent has time for the next task.
      const claim = await board
        .as(agent.name)
        .tasks.claim(message.id, { lease: LEASE_SECONDS })
        .catch(() => null);
      if (claim === null) {
        continue;
      }
      const run: Run = {
        agent: agent.name,
        channel: message.channel,
        claim: { epoch: claim.epoch, token: claim.token },
        conversationId: null,
        cost: 0,
        endedAt: null,
        id: crypto.randomUUID().slice(0, 8),
        note: null,
        startedAt: Date.now(),
        state: "starting",
        steps: 0,
        submissionId: null,
        taskId: message.id,
        title: firstLine(message.text),
        tokens: 0,
      };
      const kept = keptOf(agent.name, message.id);
      store.insertRun(run);
      if (kept !== null) {
        store.updateRun(run.id, { conversationId: kept });
      }
      busy.set(agent.name, (busy.get(agent.name) ?? 0) + 1);
      log(
        `run ${run.id}: ${agent.name} takes #${message.id} in #${message.channel}`
      );
      launch({ ...run, conversationId: kept });
    }
  };

  /** Make the task of a schedule, for its agent. */
  const fire = async (agent: Agent, index: number) => {
    const schedule = agent.schedules[index];
    if (schedule === undefined) {
      throw new Error("The agent has no such schedule.");
    }
    const input = {
      labels: { "factory.agent": agent.name, "factory.schedule": "1" },
      text: schedule.text,
    };
    const scheduler = board.as("schedule");
    try {
      return (await scheduler.tasks.create(schedule.channel, input)).task.id;
    } catch {
      // The channel is new.
      await board.createChannel(schedule.channel);
      return (await scheduler.tasks.create(schedule.channel, input)).task.id;
    }
  };

  /** The next time of each schedule, by `agent|index|cron|zone`: a changed schedule starts again. */
  const due = store.scheduleTimes();
  const fireSchedules = async () => {
    const now = Date.now();
    const all = store.list("agents").flatMap((agent) =>
      agent.schedules.map((schedule, index) => ({
        agent,
        index,
        key: `${agent.name}|${index}|${schedule.cron}|${schedule.zone}`,
        schedule,
      }))
    );
    const keys = new Set(all.map((one) => one.key));
    for (const key of [...due.keys()].filter((one) => !keys.has(one))) {
      due.delete(key);
      store.removeScheduleTime(key);
    }
    // A schedule that is new has no time yet: it gets its first time, and does not fire. A schedule
    // that was due while Factory was down has its old time: it fires now, one time.
    const late = all.filter((one) => now >= (due.get(one.key) ?? now + 1));
    for (const one of all) {
      if (!due.has(one.key) || late.includes(one)) {
        const next = nextRun(one.schedule, new Date(now));
        const at = next === null ? Number.MAX_SAFE_INTEGER : next.getTime();
        due.set(one.key, at);
        store.setScheduleTime(one.key, at);
      }
    }
    await Promise.all(
      late
        .filter((one) => one.agent.enabled)
        .map((one) =>
          fire(one.agent, one.index).catch((error) =>
            log(`schedule of ${one.agent.name}: ${error}`)
          )
        )
    );
  };

  let ticking = false;
  let again = false;
  const tick = async () => {
    if (ticking) {
      again = true;
      return;
    }
    ticking = true;
    try {
      do {
        again = false;
        // biome-ignore lint/performance/noAwaitInLoops: one round at a time; a round that was asked for meanwhile follows.
        await fireSchedules();
        await assign();
      } while (again);
    } catch (error) {
      log(`tick: ${error}`);
    } finally {
      ticking = false;
    }
  };

  // Continue the runs that the last process cut off, and remove the boxes of runs that are over.
  const cutOff = store.runs({ live: true }, LIVE_MAX);
  const boxes = await provider.boxes().catch(() => []);
  await Promise.all(
    boxes
      .filter((id) => !cutOff.some((run) => run.id === id))
      .map((id) => provider.stop(id).catch(() => undefined))
  );
  for (const run of cutOff) {
    launch(run);
  }

  const events = new AbortController();
  let settle: ReturnType<typeof setTimeout> | null = null;
  const watch = async () => {
    for await (const _event of board.events({}, { signal: events.signal })) {
      if (settle !== null) {
        clearTimeout(settle);
      }
      settle = setTimeout(tick, EVENT_SETTLE_MS);
    }
  };
  watch().catch(() => undefined);
  const timer = setInterval(tick, TICK_MS);
  await tick();

  return {
    close: async () => {
      events.abort();
      clearInterval(timer);
      if (settle !== null) {
        clearTimeout(settle);
      }
      // The runs stay live in the store: the next process continues them.
      for (const entry of live.values()) {
        if (entry.timer !== null) {
          clearInterval(entry.timer);
        }
        entry.connection?.close();
      }
      await harness.close(context);
    },
    nextRuns: () =>
      Object.fromEntries(
        [...due].map(([key, at]) => [key.split("|").slice(0, 2).join("|"), at])
      ),
    runNow: (name, index) => {
      const agent = store.get("agents", name);
      return agent === null
        ? Promise.reject(new Error("No such agent."))
        : fire(agent, index);
    },
    steps: async (run) => {
      const conversation =
        run.conversationId === null
          ? undefined
          : await harness.conversation(run.conversationId as never, context);
      return conversation === undefined
        ? []
        : stepsOf(await entriesOf(conversation, context));
    },
    stop: async (id, by) => {
      const entry = live.get(id);
      if (entry !== undefined) {
        entry.stoppedBy = by;
        await entry.conversation?.abort(context);
      }
    },
    tick,
    whenIdle: async () => {
      while (live.size > 0) {
        // biome-ignore lint/performance/noAwaitInLoops: a run that ends can start the next one.
        await Promise.all([...live.values()].map((entry) => entry.done));
      }
    },
  };
};

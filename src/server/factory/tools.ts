import {
  defineExtension,
  defineTool,
  type Extension,
} from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { Board, MessageView } from "@vercel/board";
import { actorName, threadText } from "./prompt.ts";

/**
 * The board as tools of an agent. They run in the Factory process, as the agent's actor on the
 * board, so a sandbox holds no credential of the board.
 */

type Held = ReturnType<Board["tasks"]["held"]>;

/** What the tools of one run act on. */
export interface RunContext {
  /** The claim on the task. */
  readonly held: Held;
  /** The board, as the agent. */
  readonly me: Board;
  /** Set when a tool ended the task: the run then ends in this state. */
  outcome: {
    readonly note: string;
    readonly state: "blocked" | "failed";
  } | null;
  readonly taskId: string;
}

const say = (text: string) => ({ output: [{ text, type: "text" as const }] });

const TITLE_MAX = 120;
/** The most tasks in a row that agents make from each other's tasks, before a person must decide. */
export const CHAIN_MAX = 12;
const taskRow = (message: MessageView) =>
  `#${message.id} [${message.task?.state ?? "thread"}] #${message.channel} ${message.text.split("\n")[0]?.slice(0, TITLE_MAX)} (from ${actorName(message.by.actor)})`;

export const boardTools = (
  contextOf: (conversationId: number) => RunContext | undefined
): Extension => {
  const need = (conversationId: number) => {
    const context = contextOf(conversationId);
    if (context === undefined) {
      throw new Error("This conversation has no task on the board.");
    }
    return context;
  };
  return defineExtension({
    name: "factory-board",
    tools: [
      defineTool({
        description:
          "Read a thread or a task of the board by its number: the text, the state and the replies.",
        execute: async (args, api) =>
          say(threadText(await need(api.conversationId).me.thread(args.id))),
        name: "board_read",
        parameters: obj({ id: str({ description: "The number: 12" }) }),
      }),
      defineTool({
        description:
          "List tasks of the board, newest first. Use it before you make a task, to find one that is already there.",
        execute: async (args, api) => {
          const page = await need(api.conversationId).me.tasks.list({
            ...(args.channel === undefined ? {} : { channel: args.channel }),
            latest: true,
            limit: 30,
            state: args.state === "all" ? "all" : "open",
          });
          return say(
            page.tasks.length === 0
              ? "No tasks."
              : page.tasks.map((task) => taskRow(task.message)).join("\n")
          );
        },
        name: "board_tasks",
        parameters: obj({
          channel: opt(str({ description: "A channel: pipes/dev" })),
          state: opt(
            str({
              description: "open (default) or all, with the finished tasks",
            })
          ),
        }),
      }),
      defineTool({
        description:
          "Write a reply in the thread of your task, for something that a person must know before you finish. Your last answer is posted without this tool.",
        execute: async (args, api) => {
          const context = need(api.conversationId);
          await context.me.reply(context.taskId, args.text);
          return say("Posted.");
        },
        name: "board_reply",
        parameters: obj({ text: str() }),
      }),
      defineTool({
        description:
          "Make a task in a channel, to hand work to the agents or the people of that channel. The text must be complete without your thread: what to do, where, and how to know that it is done.",
        execute: async (args, api) => {
          const context = need(api.conversationId);
          const mine = await context.me.thread(context.taskId, { limit: 1 });
          const depth = Number(mine.message.labels["factory.depth"] ?? "0");
          if (depth >= CHAIN_MAX) {
            return {
              ...say(
                `This task is number ${depth} in a chain of tasks that agents made. A chain stops at ${CHAIN_MAX}: give the work to a person with task_block.`
              ),
              isError: true,
            };
          }
          const made = await context.me.tasks.create(args.channel, {
            labels: {
              // How long the chain of agents' tasks is, so it cannot go on without an end.
              "factory.depth": String(depth + 1),
              // The flow page reads where each task came from.
              "factory.from": context.taskId,
            },
            text: args.text,
          });
          return say(`Task #${made.task.id} is in #${args.channel}.`);
        },
        name: "board_task",
        parameters: obj({
          channel: str({ description: "The channel: pipes/dev" }),
          text: str({ description: "The first line is the title." }),
        }),
      }),
      defineTool({
        description:
          "Give your task to a person and stop: you need an answer or a decision. The task continues when the person answers.",
        execute: async (args, api) => {
          const context = need(api.conversationId);
          await context.held.block(args.question, { kind: "needs_input" });
          context.outcome = { note: args.question, state: "blocked" };
          return {
            ...say("The task waits for a person."),
            control: { terminate: true },
          };
        },
        name: "task_block",
        parameters: obj({ question: str() }),
      }),
      defineTool({
        description:
          "Say that your task cannot be done, with the reason, and stop.",
        execute: async (args, api) => {
          const context = need(api.conversationId);
          await context.held.fail(args.reason);
          context.outcome = { note: args.reason, state: "failed" };
          return {
            ...say("The task is failed."),
            control: { terminate: true },
          };
        },
        name: "task_fail",
        parameters: obj({ reason: str() }),
      }),
    ],
  });
};

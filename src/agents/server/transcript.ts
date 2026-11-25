import type { Conversation } from "@earendil-works/pi-durable";

/** A conversation of an agent as the steps of a run's log, and as what it spent. */

/** One thing an agent did. */
export interface Step {
  readonly at: number;
  /** A tool call that ended with an error, or a model error. */
  readonly failed: boolean;
  readonly kind: "say" | "tool";
  /** The output of a tool, cut to a readable length. */
  readonly output: string;
  /** What it said, or the arguments of the tool in one line. */
  readonly text: string;
  readonly tool: string;
}

export type Entry = Awaited<
  ReturnType<Conversation["entries"]>
>["items"][number];

interface ModelMessage {
  readonly content?: unknown;
  readonly errorMessage?: string;
  readonly isError?: boolean;
  readonly timestamp?: number;
  readonly toolCallId?: string;
  readonly usage?: {
    readonly cost?: { readonly total?: number };
    readonly totalTokens?: number;
  };
}

interface Part {
  readonly arguments?: Record<string, unknown>;
  readonly id?: string;
  readonly name?: string;
  readonly text?: string;
  readonly type?: string;
}

const ENTRY_PAGE = 500;
const OUTPUT_MAX = 20_000;
/** The argument that says most about a call of each tool. */
const MAIN_ARGUMENTS = [
  "command",
  "path",
  "channel",
  "id",
  "question",
  "reason",
];

const messageOf = (entry: Entry | undefined) =>
  (entry?.model?.[0] ?? {}) as ModelMessage;

const partsOf = (message: ModelMessage): Part[] =>
  Array.isArray(message.content) ? (message.content as Part[]) : [];

const text = (message: ModelMessage) =>
  partsOf(message)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();

/** What the agent said in an entry. */
export const textOf = (entry: Entry | undefined) => text(messageOf(entry));

/** All entries of a conversation, oldest first. */
export const entriesOf = async (
  conversation: Conversation,
  context: Parameters<Conversation["entries"]>[3]
) => {
  const entries: Entry[] = [];
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    // biome-ignore lint/performance/noAwaitInLoops: each page needs the cursor of the page before it.
    const page = await conversation.entries(
      { order: "ascending" },
      ENTRY_PAGE,
      cursor,
      context
    );
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
};

const argumentLine = (args: Record<string, unknown> | undefined) => {
  const main = MAIN_ARGUMENTS.map((key) => args?.[key]).find(
    (value) => typeof value === "string"
  );
  return typeof main === "string" ? main : JSON.stringify(args ?? {});
};

/** The steps of one answer of the model, each with the ID of its tool call. */
const answerSteps = (message: ModelMessage) => {
  const at = message.timestamp ?? 0;
  const base = { at, failed: false, output: "", tool: "" };
  const steps: { readonly call: string | null; readonly step: Step }[] = [];
  for (const part of partsOf(message)) {
    if (part.type === "text" && (part.text ?? "").trim() !== "") {
      steps.push({
        call: null,
        step: { ...base, kind: "say", text: (part.text ?? "").trim() },
      });
    } else if (part.type === "toolCall") {
      steps.push({
        call: part.id ?? "",
        step: {
          ...base,
          kind: "tool",
          text: argumentLine(part.arguments),
          tool: part.name ?? "",
        },
      });
    }
  }
  if (message.errorMessage !== undefined) {
    steps.push({
      call: null,
      step: { ...base, failed: true, kind: "say", text: message.errorMessage },
    });
  }
  return steps;
};

export const stepsOf = (entries: readonly Entry[]): Step[] => {
  const list: Step[] = [];
  const calls = new Map<string, number>();
  for (const entry of entries) {
    const message = messageOf(entry);
    if (entry.kind === "pi.assistant") {
      for (const { call, step } of answerSteps(message)) {
        if (call !== null) {
          calls.set(call, list.length);
        }
        list.push(step);
      }
    }
    const index = calls.get(message.toolCallId ?? "");
    const step = index === undefined ? undefined : list[index];
    if (entry.kind === "pi.tool-result" && index !== undefined && step) {
      list[index] = {
        ...step,
        failed: message.isError === true,
        output: text(message).slice(-OUTPUT_MAX),
      };
    }
  }
  return list;
};

/** The tokens, the cost and the tool calls of a conversation. */
export const spentOf = (entries: readonly Entry[]) => {
  const answers = entries
    .filter((entry) => entry.kind === "pi.assistant")
    .map(messageOf);
  return {
    cost: answers.reduce((sum, one) => sum + (one.usage?.cost?.total ?? 0), 0),
    steps: answers.reduce(
      (sum, one) =>
        sum + partsOf(one).filter((part) => part.type === "toolCall").length,
      0
    ),
    tokens: answers.reduce(
      (sum, one) => sum + (one.usage?.totalTokens ?? 0),
      0
    ),
  };
};

import type { MessageView, ThreadSummaryView } from "@vercel/board";

/** What the board page shows, as its URL says: `/board?channel=…&thread=…`, `/board/tasks?state=…`. */

export const TASK_FILTERS = [
  "open",
  "blocked",
  "ready",
  "claimed",
  "waiting",
  "completed",
  "failed",
  "canceled",
  "all",
] as const;

export type TaskFilter = (typeof TASK_FILTERS)[number];
export type TaskView = NonNullable<MessageView["task"]>;
export type TaskState = TaskView["state"];
export type BoardView = "activity" | "channel" | "tasks";

/** The lists that show finished tasks: newest first, since the oldest ones are history. */
export const FINISHED_FILTERS = new Set<TaskFilter>([
  "all",
  "canceled",
  "completed",
  "failed",
]);

export const ACTIVE_FILTERS = new Set<TaskFilter>([
  "open",
  "blocked",
  "ready",
  "claimed",
  "waiting",
]);

export interface BoardQuery {
  /** The channel view's channel, or the filter of the tasks view (a channel, or a subtree with a trailing slash). */
  readonly channel: string | null;
  readonly state: TaskFilter;
  /** The thread in the pane, or null. */
  readonly thread: string | null;
  readonly view: BoardView;
}

const MESSAGE_ID = /^\d{1,12}$/;
const TASK_PATH = /^\/board\/tasks\/(\d{1,12})$/;

/** The query of a board URL. `/board/tasks/<id>` is the permalink of a task. */
export const boardQuery = (url: URL): BoardQuery => {
  const params = url.searchParams;
  const permalink = url.pathname.match(TASK_PATH)?.[1] ?? null;
  const thread = permalink ?? params.get("thread");
  const channel = params.get("channel")?.trim() || null;
  const tasks = url.pathname.startsWith("/board/tasks");
  let view: BoardView = "activity";
  if (tasks) {
    view = "tasks";
  } else if (channel !== null) {
    view = "channel";
  }
  return {
    channel,
    state:
      TASK_FILTERS.find((filter) => filter === params.get("state")) ?? "open",
    thread: thread !== null && MESSAGE_ID.test(thread) ? thread : null,
    view,
  };
};

/** The URL of a board view. */
export const boardHref = (
  query: BoardQuery,
  change: Partial<BoardQuery> = {}
) => {
  const next = { ...query, ...change };
  const params = new URLSearchParams();
  if (next.view !== "activity" && next.channel !== null) {
    params.set("channel", next.channel);
  }
  if (next.view === "tasks" && next.state !== "open") {
    params.set("state", next.state);
  }
  if (next.thread !== null) {
    params.set("thread", next.thread);
  }
  const search = params.toString();
  const path = next.view === "tasks" ? "/board/tasks" : "/board";
  return search === "" ? path : `${path}?${search}`;
};

const HEADING = /^#+\s*/;
const USER_PRINCIPAL = /^factory:(user|agent):/;

/** The first line of a message: the title of a task. */
export const titleOf = (text: string) => {
  const line = text.split("\n").find((part) => part.trim() !== "") ?? "";
  return line.trim().replace(HEADING, "") || "(no text)";
};

/** Who wrote a message or holds a task, for people. */
export const actorName = (actor: string | null | undefined) => {
  if (actor === null || actor === undefined) {
    return "—";
  }
  return actor.startsWith("board:")
    ? "Factory"
    : actor.replace(USER_PRINCIPAL, "");
};

/** The labels that people set and read; the board's own labels stay hidden. */
export const visibleLabels = (labels: Readonly<Record<string, string>>) =>
  Object.entries(labels).filter(([key]) => !key.startsWith("board."));

/**
 * A task's state now. A claim past its lease is over, so the task is ready, whatever the board last
 * wrote: the board writes the change only when something asks.
 */
export const stateNow = (task: TaskView, now: number): TaskState =>
  task.state === "claimed" &&
  task.claim !== null &&
  Date.parse(task.claim.until) <= now
    ? "ready"
    : task.state;

/** The time left of a claim, as `4:05`. */
export const timeLeft = (until: string, now: number) => {
  const seconds = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** A task's state in the words of people. The board's own word stays in the URL and the tooltip. */
export const STATE_LABEL: Record<TaskState, string> = {
  blocked: "needs a person",
  canceled: "canceled",
  claimed: "working",
  completed: "done",
  failed: "failed",
  ready: "to do",
  waiting: "waits for tasks",
};

export const FILTER_LABEL: Record<TaskFilter, string> = {
  ...STATE_LABEL,
  all: "all",
  open: "open",
};

export const FILTER_HELP: Record<TaskFilter, string> = {
  all: "Every task, newest first.",
  blocked: "Tasks that wait for a person: an answer or a decision.",
  canceled: "Canceled tasks, newest first. A canceled task cannot be reopened.",
  claimed: "Tasks that someone works on now.",
  completed: "Finished tasks with their results, newest first.",
  failed:
    "Tasks that could not be done, newest first. Reopen one to try again.",
  open: "Every task that is not finished, oldest first.",
  ready: "Tasks that wait for someone to start them.",
  waiting: "Tasks that start when the tasks they wait for are done.",
};

export const STATE_MARK: Record<TaskState, string> = {
  blocked: "⏸",
  canceled: "⊘",
  claimed: "◉",
  completed: "✓",
  failed: "✕",
  ready: "○",
  waiting: "◌",
};

/** A channel is in a filter: the channel itself, or under a subtree. */
export const inFilter = (channel: string, filter: string | null) =>
  filter === null ||
  channel === filter ||
  (filter.endsWith("/") && channel.startsWith(filter)) ||
  channel.startsWith(`${filter}/`);

export const lastActive = (summary: ThreadSummaryView) =>
  Date.parse(summary.last?.createdAt ?? summary.message.createdAt);

/** A channel path: lowercase parts with `/` between them, as `fix/pipes`. */
export const CHANNEL_PATH = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

const LABEL_PAIR = /^([^=\s]+)\s*=(.*)$/;
const TASK_REF = /^#?(\d{1,12})$/;
const NEEDS_SEPARATOR = /[\s,]+/;

/** Labels from `kind=code, team=web`. Parts without `=` are ignored. */
export const parseLabels = (text: string) =>
  Object.fromEntries(
    text
      .split(",")
      .map((part) => part.trim().match(LABEL_PAIR))
      .filter((match) => match !== null)
      .map((match) => [match[1] ?? "", (match[2] ?? "").trim()])
  );

/** Task IDs from `#12 #14` or `12, 14`. */
export const parseNeeds = (text: string) =>
  text
    .split(NEEDS_SEPARATOR)
    .map((part) => part.match(TASK_REF)?.[1])
    .filter((id) => id !== undefined);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The first letter of a name, for its square avatar. */
export const initialOf = (name: string) =>
  (name.trim()[0] ?? "?").toUpperCase();

const dayKey = (time: number) => new Date(time).toDateString();

/** The divider of a day in a feed: `today`, `yesterday`, or the date. */
export const dayLabel = (time: number, now: number) => {
  if (dayKey(time) === dayKey(now)) {
    return "today";
  }
  if (dayKey(time) === dayKey(now - DAY)) {
    return "yesterday";
  }
  return new Date(time).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    weekday: "long",
  });
};

export const sameDay = (a: number, b: number) => dayKey(a) === dayKey(b);

/** A short age: `now`, `4m`, `3h`, `2d`. */
export const shortAge = (time: number, now: number) => {
  const delta = Math.max(0, now - time);
  if (delta < MINUTE) {
    return "now";
  }
  if (delta < HOUR) {
    return `${Math.floor(delta / MINUTE)}m`;
  }
  if (delta < DAY) {
    return `${Math.floor(delta / HOUR)}h`;
  }
  return `${Math.floor(delta / DAY)}d`;
};

/** Messages from one author in a row, a few minutes apart, show as one block. */
const CONTINUED_MS = 5 * MINUTE;

export const continues = (
  previous: MessageView | undefined,
  message: MessageView
) =>
  previous !== undefined &&
  previous.by.actor === message.by.actor &&
  previous.channel === message.channel &&
  previous.task === undefined &&
  message.task === undefined &&
  sameDay(Date.parse(previous.createdAt), Date.parse(message.createdAt)) &&
  Date.parse(message.createdAt) - Date.parse(previous.createdAt) < CONTINUED_MS;

/** The open tasks by state, for the counts of the header and the tabs. */
export const countStates = (roots: readonly MessageView[], now: number) => {
  const counts: Partial<Record<TaskState, number>> = {};
  for (const root of roots) {
    if (root.task !== undefined) {
      const state = stateNow(root.task, now);
      counts[state] = (counts[state] ?? 0) + 1;
    }
  }
  return counts;
};

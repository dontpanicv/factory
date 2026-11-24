import type { MessageView, ThreadSummaryView } from "@vercel/board";
import { get, post } from "./api.ts";
import {
  ACTIVE_FILTERS,
  actorName,
  type BoardQuery,
  type BoardView,
  boardHref,
  bodyOf,
  CHANNEL_PATH,
  FILTER_HELP,
  FILTER_LABEL,
  FINISHED_FILTERS,
  formatAge,
  formatAgo,
  inFilter,
  lastActive,
  parseLabels,
  parseNeeds,
  STATE_LABEL,
  STATE_MARK,
  stateNow,
  TASK_FILTERS,
  type TaskFilter,
  timeLeft,
  titleOf,
  visibleLabels,
} from "./model.ts";
import { navigate } from "./route.ts";

/**
 * The board has the structure of the Board viewer (`vb inspect`): a sidebar with the activity, the
 * tasks and the channels; the main view with a composer below it; and the pane of the open thread.
 */

const OPEN_LIMIT = 200;
const LIST_LIMIT = 200;
const THREAD_LIMIT = 100;
const CHANNEL_LIMIT = 500;
const SPACES = /\s+/g;

export interface BoardData {
  /** Every channel, with its open tasks. */
  readonly channels: ReadonlyArray<{
    readonly open: number;
    readonly path: string;
  }>;
  /** The open tasks of the view's channel filter, by state, for the tabs. */
  readonly counts: Readonly<Partial<Record<TaskFilter, number>>>;
  readonly open: { readonly blocked: number; readonly total: number };
  /** What the composer suggests: labels, and the open tasks that a new task can start after. */
  readonly suggest: {
    readonly labels: readonly string[];
    readonly tasks: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
    }>;
  };
  /** The view's threads (activity, channel: the board gives the newest last) or tasks. */
  readonly threads: readonly ThreadSummaryView[];
}

interface TasksPage {
  readonly tasks: ThreadSummaryView[];
}

const listTasks = async (query: BoardQuery) => {
  const finished = FINISHED_FILTERS.has(query.state);
  const page = await get<TasksPage>("/tasks", {
    channel: query.channel ?? undefined,
    latest: finished || undefined,
    limit: LIST_LIMIT,
    state: query.state,
  });
  return finished
    ? page.tasks.toSorted((a, b) => lastActive(b) - lastActive(a))
    : page.tasks;
};

const listThreads = async (query: BoardQuery) => {
  const page = await get<{ threads: ThreadSummaryView[] }>("/threads", {
    channel:
      query.view === "channel" ? (query.channel ?? undefined) : undefined,
    limit: THREAD_LIMIT,
  });
  return page.threads;
};

export const loadBoard = async (query: BoardQuery): Promise<BoardData> => {
  const [open, channels, threads] = await Promise.all([
    get<TasksPage>("/tasks", { limit: OPEN_LIMIT, state: "open" }),
    get<{ channels: Array<{ path: string }> }>("/channels", {
      limit: CHANNEL_LIMIT,
    }),
    query.view === "tasks" ? listTasks(query) : listThreads(query),
  ]);
  const roots = open.tasks.map(({ message }) => message);
  const counts: Partial<Record<TaskFilter, number>> = {};
  for (const root of roots) {
    const state = root.task?.state;
    if (state !== undefined && inFilter(root.channel, query.channel)) {
      counts[state] = (counts[state] ?? 0) + 1;
      counts.open = (counts.open ?? 0) + 1;
    }
  }
  return {
    channels: channels.channels.map(({ path }) => ({
      open: roots.filter((root) => root.channel === path).length,
      path,
    })),
    counts,
    open: {
      blocked: roots.filter((root) => root.task?.state === "blocked").length,
      total: roots.length,
    },
    suggest: {
      labels: [
        ...new Set(
          roots.flatMap((root) =>
            visibleLabels(root.labels).map(([key, value]) => `${key}=${value}`)
          )
        ),
      ].sort(),
      tasks: roots
        .map((root) => ({ id: root.id, title: titleOf(root.text) }))
        .toReversed(),
    },
    threads,
  };
};

/** The trimmed value of a form field. */
export const fieldOf = (form: HTMLFormElement, name: string) => {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** What a person does with the board: each write reloads the view, and a failure shows its message. */
export type Run = (write: () => Promise<unknown>) => Promise<boolean>;

// The sidebar

const SideItem = (props: {
  readonly alert?: boolean;
  readonly count?: number;
  readonly current: boolean;
  readonly href: string;
  readonly label: string;
  readonly title: string;
}) => (
  <a
    aria-current={props.current ? "page" : undefined}
    class="side__item"
    href={props.href}
    title={props.title}
  >
    <span class="truncate">{props.label}</span>
    <span class="spacer" />
    {props.count === undefined || props.count === 0 ? null : (
      <span
        class={
          props.alert === true
            ? "side__count side__count--alert"
            : "side__count"
        }
      >
        {props.count}
      </span>
    )}
  </a>
);

/** The channels by the first part of their path: `detect/sre` is `#sre` under `detect`. */
const channelGroups = (channels: BoardData["channels"]) => {
  const groups = new Map<string, BoardData["channels"][number][]>();
  for (const channel of channels) {
    const slash = channel.path.indexOf("/");
    const group = slash === -1 ? "" : channel.path.slice(0, slash);
    groups.set(group, [...(groups.get(group) ?? []), channel]);
  }
  // Channels without a group come first, as the viewer lists them.
  return [...groups.entries()].toSorted(([a], [b]) =>
    a === "" || b === "" ? Number(a !== "") - Number(b !== "") : 0
  );
};

export const BoardSide = (props: {
  readonly data: BoardData;
  readonly query: BoardQuery;
}) => {
  const { data, query } = props;
  return (
    <nav aria-label="Board" class="side__nav">
      <SideItem
        current={query.view === "activity"}
        href={boardHref(query, {
          channel: null,
          thread: null,
          view: "activity",
        })}
        label="Latest"
        title="The newest threads and tasks of every channel"
      />
      <SideItem
        count={data.open.total}
        current={
          query.view === "tasks" &&
          query.channel === null &&
          query.state !== "blocked"
        }
        href={boardHref(query, {
          channel: null,
          state: "open",
          thread: null,
          view: "tasks",
        })}
        label="All tasks"
        title="All tasks by state. The number is the open tasks."
      />
      <SideItem
        alert
        count={data.open.blocked}
        current={
          query.view === "tasks" &&
          query.channel === null &&
          query.state === "blocked"
        }
        href={boardHref(query, {
          channel: null,
          state: "blocked",
          thread: null,
          view: "tasks",
        })}
        label="Needs a person"
        title="Tasks that wait for an answer or a decision"
      />
      <span class="side__head label">Channels</span>
      {data.channels.length === 0 ? (
        <span class="hint small side__group-name">No channels yet.</span>
      ) : null}
      {channelGroups(data.channels).map(([group, channels]) => (
        <div class="side__group" key={group}>
          {group === "" ? null : <span class="side__group-name">{group}</span>}
          {channels.map((channel) => (
            <a
              aria-current={query.channel === channel.path ? "page" : undefined}
              class={
                group === ""
                  ? "side__item side__item--channel"
                  : "side__item side__item--channel side__item--nested"
              }
              href={boardHref(query, {
                channel: channel.path,
                thread: null,
                view: query.view === "tasks" ? "tasks" : "channel",
              })}
              key={channel.path}
              title={`#${channel.path}${channel.open === 0 ? "" : ` · ${channel.open} open`}`}
            >
              <span class="truncate">{`#${group === "" ? channel.path : channel.path.slice(group.length + 1)}`}</span>
              <span class="spacer" />
              {channel.open === 0 ? null : (
                <span class="side__count">{channel.open}</span>
              )}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
};

/** The form of "+": a channel that exists before anything posts to it. */
export const NewChannel = (props: {
  readonly query: BoardQuery;
  readonly run: Run;
}) => {
  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const channel = fieldOf(form, "path").toLowerCase();
    if (await props.run(() => post("/channels", { path: channel }))) {
      form.reset();
      navigate(
        boardHref(props.query, { channel, thread: null, view: "channel" })
      );
    }
  };
  return (
    <details class="side__new">
      <summary class="side__new-toggle">+ New channel</summary>
      <form class="side__new-form" onSubmit={create}>
        <input
          aria-label="Channel path"
          class="input mono composer__field"
          name="path"
          pattern={CHANNEL_PATH.source.slice(1, -1)}
          placeholder="fix/web"
          required
        />
        <span class="hint small">
          Lowercase path. Prefix before / groups it.
        </span>
        <button class="button button--secondary button--small" type="submit">
          Create channel
        </button>
      </form>
    </details>
  );
};

// The main view

const ViewHead = (props: { readonly query: BoardQuery }) => {
  const { query } = props;
  let title = "Latest";
  let sub: string | null =
    "The newest threads and tasks of every channel, newest first.";
  if (query.view === "channel") {
    title = `#${query.channel ?? ""}`;
    sub = null;
  } else if (query.view === "tasks") {
    title = query.channel === null ? "Tasks" : `#${query.channel}`;
    sub = FILTER_HELP[query.state];
  }
  const canSwitchView = query.channel !== null && !query.channel.endsWith("/");
  return (
    <header class="view__head">
      <h1 class="view__title">{title}</h1>
      <span class="spacer" />
      {canSwitchView ? (
        <nav aria-label="Channel view" class="segmented">
          <a
            aria-current={query.view === "channel" ? "page" : undefined}
            class="segmented__item"
            href={boardHref(query, { thread: null, view: "channel" })}
          >
            Feed
          </a>
          <a
            aria-current={query.view === "tasks" ? "page" : undefined}
            class="segmented__item"
            href={boardHref(query, {
              state: "open",
              thread: null,
              view: "tasks",
            })}
          >
            Tasks
          </a>
        </nav>
      ) : null}
      {query.view === "tasks" && query.channel !== null ? (
        <a
          class="button button--secondary button--small"
          href={boardHref(query, { channel: null, thread: null })}
        >
          All channels
        </a>
      ) : null}
      {sub === null ? null : <p class="view__sub">{sub}</p>}
    </header>
  );
};

const StateTabs = (props: {
  readonly counts: BoardData["counts"];
  readonly query: BoardQuery;
}) => {
  const { counts, query } = props;
  const tab = (filter: TaskFilter) => (
    <a
      aria-current={query.state === filter ? "page" : undefined}
      class={
        filter === "blocked" && (counts.blocked ?? 0) > 0
          ? "tabs__item tabs__item--alert"
          : "tabs__item"
      }
      href={boardHref(query, { state: filter, thread: null })}
      key={filter}
      title={FILTER_HELP[filter]}
    >
      {FILTER_LABEL[filter]}
      {counts[filter] === undefined ? null : (
        <span class="tabs__count">{counts[filter]}</span>
      )}
    </a>
  );
  return (
    <nav aria-label="Task states" class="tabs">
      {TASK_FILTERS.filter((filter) => ACTIVE_FILTERS.has(filter)).map(tab)}
      <span aria-hidden="true" class="tabs__sep" />
      {TASK_FILTERS.filter((filter) => !ACTIVE_FILTERS.has(filter)).map(tab)}
    </nav>
  );
};

export const Labels = (props: {
  readonly labels: Readonly<Record<string, string>>;
  readonly max?: number;
}) => {
  const labels = visibleLabels(props.labels);
  const shown = labels.slice(0, props.max ?? labels.length);
  return shown.length === 0 ? null : (
    <span class="labels">
      {shown.map(([key, value]) => (
        <span class="tag" key={key}>{`${key}=${value}`}</span>
      ))}
      {labels.length > shown.length ? <span class="muted">…</span> : null}
    </span>
  );
};

/** The second line of a task: who holds it, what it waits for, how it ended. */
const TaskDetail = (props: {
  readonly now: number;
  readonly root: MessageView;
}) => {
  const { task } = props.root;
  if (task === undefined) {
    return null;
  }
  const state = stateNow(task, props.now);
  const text = (() => {
    switch (state) {
      case "claimed":
        return task.claim === null
          ? ""
          : `${actorName(task.claim.actor)} · claim ends in ${timeLeft(task.claim.until, props.now)}`;
      case "blocked":
        return task.blocked === null
          ? "Reply to continue."
          : `${task.blocked.kind ?? "held"}: ${task.blocked.reason}`;
      case "waiting":
        return `starts after ${task.needs.map((need) => `#${need}`).join(" ")}`;
      case "completed":
        return task.result ?? "";
      case "failed":
      case "canceled":
        return task.reason ?? state;
      default:
        return task.for === null ? "for anyone" : `for ${actorName(task.for)}`;
    }
  })();
  return <span class={`row__detail row__detail--${state}`}>{text}</span>;
};

const TaskRow = (props: {
  readonly now: number;
  readonly query: BoardQuery;
  readonly summary: ThreadSummaryView;
}) => {
  const { now, query, summary } = props;
  const root = summary.message;
  const state = root.task === undefined ? null : stateNow(root.task, now);
  const open = query.thread === root.id;
  return (
    <article class={open ? "row-item row-item--open" : "row-item"}>
      <span
        aria-hidden="true"
        class={
          state === null
            ? "muted row-item__mark"
            : `row-item__mark task-state--${state}`
        }
        title={state === null ? "Thread" : `${STATE_LABEL[state]} (${state})`}
      >
        {state === null ? "·" : STATE_MARK[state]}
      </span>
      <div class="row-item__main">
        <div class="row-item__top">
          <a
            aria-current={open ? "true" : undefined}
            class="row-item__title"
            href={boardHref(query, { thread: root.id })}
          >
            <span class="muted mono">{`#${root.id}`}</span>
            {` ${titleOf(root.text)}`}
          </a>
          <span class="row-item__aside">
            {query.channel === root.channel ? null : (
              <span class="mono row-item__channel">{`#${root.channel}`}</span>
            )}
            <span class="row-item__age">
              {formatAge(now - lastActive(summary))}
            </span>
          </span>
        </div>
        <div class="row-item__meta">
          {state === null ? (
            <span class="task-state">thread</span>
          ) : (
            <span
              class={`task-state task-state--${state}`}
              title={`Board state: ${state}`}
            >
              {STATE_LABEL[state]}
            </span>
          )}
          <TaskDetail now={now} root={root} />
          <Labels labels={root.labels} max={3} />
        </div>
      </div>
    </article>
  );
};

/** A thread in the activity or a channel: title, metadata, preview, and latest reply. */
const ThreadItem = (props: {
  readonly now: number;
  readonly query: BoardQuery;
  readonly summary: ThreadSummaryView;
}) => {
  const { now, query, summary } = props;
  const root = summary.message;
  const { last, replies } = summary;
  const body = bodyOf(root.text);
  const state = root.task === undefined ? null : stateNow(root.task, now);
  const open = query.thread === root.id;
  return (
    <article class={open ? "feed-item feed-item--open" : "feed-item"}>
      <div class="feed-item__top">
        {state === null ? null : (
          <span
            aria-hidden="true"
            class={`task-state--${state} mono`}
            title={`${STATE_LABEL[state]} (${state})`}
          >
            {STATE_MARK[state]}
          </span>
        )}
        <a
          aria-current={open ? "true" : undefined}
          class="feed-item__title"
          href={boardHref(query, { thread: root.id })}
        >
          <span class="muted mono">{`#${root.id}`}</span>
          {` ${titleOf(root.text)}`}
        </a>
        <span class="row-item__aside">
          {query.channel === root.channel ? null : (
            <a
              class="mono row-item__channel"
              href={boardHref(query, {
                channel: root.channel,
                thread: null,
                view: "channel",
              })}
            >{`#${root.channel}`}</a>
          )}
          <span class="row-item__age">
            {formatAgo(Date.parse(root.createdAt), now)}
          </span>
        </span>
      </div>
      <div class="feed-item__meta">
        <strong>{actorName(root.by.actor)}</strong>
        {state === null ? null : (
          <span
            class={`task-state task-state--${state}`}
            title={`Board state: ${state}`}
          >
            {STATE_LABEL[state]}
          </span>
        )}
        <TaskDetail now={now} root={root} />
        <Labels labels={root.labels} max={3} />
      </div>
      {body === "" ? null : <p class="feed-item__body">{body}</p>}
      {last === null ? null : (
        <div class="feed-item__reply">
          <strong>{actorName(last.by.actor)}</strong>
          <span class="feed-item__reply-text">
            {last.deleted ? "(deleted)" : last.text.replaceAll(SPACES, " ")}
          </span>
          <span class="muted nowrap">
            {`${replies > 1 ? `${replies} replies · ` : ""}${formatAgo(Date.parse(last.createdAt), now)}`}
          </span>
        </div>
      )}
    </article>
  );
};

const EMPTY: Record<BoardView, string> = {
  activity: "Nothing on the board yet. Create a channel, then a task below.",
  channel: "Nothing in this channel yet. Create a task below.",
  tasks: "No tasks in this list.",
};

export const BoardMain = (props: {
  readonly data: BoardData;
  readonly now: number;
  readonly query: BoardQuery;
}) => {
  const { data, now, query } = props;
  const tasks = query.view === "tasks";
  return (
    <div class="view__live">
      <ViewHead query={query} />
      {tasks ? <StateTabs counts={data.counts} query={query} /> : null}
      <div class="view__list">
        {data.threads.length === 0 ? (
          <p class="hint view__empty">{EMPTY[query.view]}</p>
        ) : (
          // The board gives the threads newest last; people read the newest first.
          (tasks ? data.threads : data.threads.toReversed()).map((summary) =>
            tasks ? (
              <TaskRow
                key={summary.message.id}
                now={now}
                query={query}
                summary={summary}
              />
            ) : (
              <ThreadItem
                key={summary.message.id}
                now={now}
                query={query}
                summary={summary}
              />
            )
          )
        )}
      </div>
    </div>
  );
};

/** Enter sends the form of a composer; Shift+Enter makes a new line. */
export const sendOnEnter = (event: KeyboardEvent) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.currentTarget instanceof HTMLTextAreaElement
  ) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
};

/** The composer below the main view creates a task in a channel, with labels and the tasks it starts after. */
export const Composer = (props: {
  readonly data: BoardData;
  readonly query: BoardQuery;
  readonly run: Run;
}) => {
  const { data, query } = props;
  const paths = data.channels.map((channel) => channel.path);
  const exact =
    query.channel !== null && !query.channel.endsWith("/")
      ? query.channel
      : null;
  const fixed = query.view === "channel" ? exact : null;
  const inSubtree = paths.filter((path) => inFilter(path, query.channel));
  const options = inSubtree.length === 0 ? paths : inSubtree;
  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    let id = "";
    const created = await props.run(async () => {
      ({
        task: { id },
      } = await post<{ task: { id: string } }>("/tasks", {
        channel: fixed ?? fieldOf(form, "channel"),
        labels: parseLabels(fieldOf(form, "labels")),
        needs: parseNeeds(fieldOf(form, "needs")),
        text: fieldOf(form, "text"),
      }));
    });
    if (created) {
      form.reset();
      navigate(boardHref(query, { thread: id }));
    }
  };
  return (
    <form class="composer" key={fixed ?? exact ?? ""} onSubmit={create}>
      <div class="composer__box">
        <textarea
          aria-label="Task"
          class="textarea composer__text"
          name="text"
          onKeyDown={sendOnEnter}
          placeholder={
            fixed === null
              ? "New task… First line is the title (Shift+Enter for new line)."
              : `New task in #${fixed}… First line is the title.`
          }
          required
        />
        <div class="composer__bar">
          {fixed === null ? (
            <select
              aria-label="Channel"
              class="select mono composer__select"
              defaultValue={exact ?? ""}
              name="channel"
              required
            >
              <option disabled value="">
                {paths.length === 0 ? "Create a channel first" : "Channel…"}
              </option>
              {options.map((path) => (
                <option key={path} value={path}>{`#${path}`}</option>
              ))}
            </select>
          ) : (
            <span class="mono muted small">{`#${fixed}`}</span>
          )}
          <span class="spacer" />
          <button
            class="button button--primary button--small"
            title="Enter creates the task. Shift+Enter makes a new line."
            type="submit"
          >
            Create task
          </button>
          <details class="composer__more">
            <summary class="composer__more-toggle">
              + Labels &amp; dependencies
            </summary>
            <div class="composer__more-fields">
              <input
                aria-label="Labels"
                autoComplete="off"
                class="input mono composer__field"
                list="composer-labels"
                name="labels"
                placeholder="Labels: kind=code"
                title="Optional. Facts about the task as key=value, separated by commas."
              />
              <datalist id="composer-labels">
                {data.suggest.labels.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
              <input
                aria-label="Starts after"
                autoComplete="off"
                class="input mono composer__field"
                list="composer-tasks"
                name="needs"
                placeholder="Starts after: #12"
                title="Optional. Open task numbers that must finish before this task starts."
              />
              <datalist id="composer-tasks">
                {data.suggest.tasks.map((task) => (
                  <option
                    key={task.id}
                    label={task.title}
                    value={`#${task.id}`}
                  />
                ))}
              </datalist>
            </div>
          </details>
        </div>
      </div>
    </form>
  );
};

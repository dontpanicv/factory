import type { MessageView, ThreadSummaryView } from "@vercel/board";
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { ChannelAgents } from "./agents.tsx";
import { get, post } from "./api.ts";
import { Composer, type Sent } from "./composer.tsx";
import { Avatar, Labels, Message, StateMark, Timeline } from "./message.tsx";
import {
  ACTIVE_FILTERS,
  actorName,
  type BoardQuery,
  boardHref,
  countStates,
  FILTER_HELP,
  FILTER_LABEL,
  FINISHED_FILTERS,
  inFilter,
  knownLabels,
  lastActive,
  shortAge,
  stateNow,
  TASK_FILTERS,
  type TaskFilter,
  type TaskState,
  titleOf,
  visibleLabels,
} from "./model.ts";
import { navigate } from "./route.ts";

/**
 * The board has the layout of the Board viewer (`vb inspect`): a sidebar with the activity, the tasks
 * and the channels; the main column with the feed or the tasks and a composer; and the thread pane.
 */

const OPEN_LIMIT = 200;
const LIST_LIMIT = 200;
const THREAD_LIMIT = 100;
const CHANNEL_LIMIT = 500;
/** How many of the feed's newest events fill the activity view: the most that one read answers. */
const RECENT_EVENTS = 100;
/** The feed is at its bottom when less than this many pixels are below the view. */
const BOTTOM_SLACK_PX = 48;

interface Channel {
  readonly open: number;
  readonly path: string;
  readonly threads?: number;
}

/** What the main column lists: messages (activity), a channel's threads, or tasks. */
export type Listing =
  | { readonly kind: "feed"; readonly messages: readonly MessageView[] }
  | {
      readonly kind: "threads";
      readonly threads: readonly ThreadSummaryView[];
    }
  | { readonly kind: "tasks"; readonly tasks: readonly ThreadSummaryView[] };

export interface BoardData {
  readonly channels: readonly Channel[];
  readonly listing: Listing;
  /** The roots of the open tasks of the whole board. */
  readonly open: readonly MessageView[];
}

interface TasksPage {
  readonly tasks: ThreadSummaryView[];
}

const listTasks = async (query: BoardQuery): Promise<Listing> => {
  const finished = FINISHED_FILTERS.has(query.state);
  const page = await get<TasksPage>("/tasks", {
    channel: query.channel ?? undefined,
    latest: finished || undefined,
    limit: LIST_LIMIT,
    state: query.state,
  });
  return {
    kind: "tasks",
    tasks: finished
      ? page.tasks.toSorted((a, b) => lastActive(b) - lastActive(a))
      : page.tasks,
  };
};

/** The newest messages across every channel, oldest first: from the newest events of the board's feed. */
const listRecent = async (): Promise<Listing> => {
  const page = await get<{ events: Array<{ message?: MessageView }> }>(
    "/events",
    { last: RECENT_EVENTS }
  );
  const messages = new Map<string, MessageView>();
  for (const { message } of page.events) {
    if (
      message !== undefined &&
      (messages.get(message.id)?.version ?? -1) < message.version
    ) {
      messages.set(message.id, message);
    }
  }
  return {
    kind: "feed",
    messages: [...messages.values()].toSorted(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
    ),
  };
};

const listThreads = async (channel: string): Promise<Listing> => {
  const page = await get<{ threads: ThreadSummaryView[] }>("/threads", {
    channel,
    limit: THREAD_LIMIT,
  });
  return { kind: "threads", threads: page.threads };
};

const listingOf = (query: BoardQuery) => {
  if (query.view === "tasks") {
    return listTasks(query);
  }
  return query.view === "channel" && query.channel !== null
    ? listThreads(query.channel)
    : listRecent();
};

export const loadBoard = async (query: BoardQuery): Promise<BoardData> => {
  const [open, channels, listing] = await Promise.all([
    get<TasksPage>("/tasks", { limit: OPEN_LIMIT, state: "open" }),
    get<{ channels: Array<{ path: string; threads?: number }> }>("/channels", {
      limit: CHANNEL_LIMIT,
    }),
    listingOf(query),
  ]);
  const roots = open.tasks.map(({ message }) => message);
  return {
    channels: channels.channels.map((channel) => ({
      open: roots.filter((root) => root.channel === channel.path).length,
      path: channel.path,
      ...(channel.threads === undefined ? {} : { threads: channel.threads }),
    })),
    listing,
    open: roots,
  };
};

/** What a person does with the board: each write reloads the view, and a failure shows its message. */
export type Run = (write: () => Promise<unknown>) => Promise<boolean>;

/** The trimmed value of a form field. */
export const fieldOf = (form: HTMLFormElement, name: string) => {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value.trim() : "";
};

// The sidebar

const SideItem = (props: {
  readonly alert?: boolean;
  readonly children: ComponentChildren;
  readonly count?: number | undefined;
  readonly current: boolean;
  readonly href: string;
  readonly title: string;
}) => (
  <a
    aria-current={props.current ? "page" : undefined}
    class="side__item"
    href={props.href}
    title={props.title}
  >
    <span class="truncate">{props.children}</span>
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

/** The channels by the first part of their path: `fix/web` is `#web` under `fix`. */
const channelGroups = (channels: readonly Channel[]) => {
  const groups = new Map<string, Channel[]>();
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

/** The form of "+": a channel that exists before anything posts to it. */
const NewChannel = (props: {
  readonly onDone: () => void;
  readonly query: BoardQuery;
  readonly run: Run;
}) => {
  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const channel = fieldOf(form, "path").toLowerCase();
    if (await props.run(() => post("/channels", { path: channel }))) {
      props.onDone();
      navigate(
        boardHref(props.query, { channel, thread: null, view: "channel" })
      );
    }
  };
  const cancel = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      props.onDone();
    }
  };
  return (
    <form class="side__new" onSubmit={create}>
      <input
        aria-label="Channel path"
        autoFocus
        class="input mono"
        name="path"
        onKeyDown={cancel}
        pattern="[a-z0-9_\-]+(/[a-z0-9_\-]+)*"
        placeholder="fix/web"
        required
        title="Lowercase parts with / between them. The part before / groups the channel."
      />
    </form>
  );
};

export const BoardSide = (props: {
  readonly data: BoardData;
  readonly query: BoardQuery;
  readonly run: Run;
  readonly user: string;
}) => {
  const { data, query } = props;
  const [adding, setAdding] = useState(false);
  const toggle = () => setAdding((value) => !value);
  const done = () => setAdding(false);
  const blocked = data.open.filter(
    (root) => root.task?.state === "blocked"
  ).length;
  return (
    <aside class="board__side">
      <nav aria-label="Board" class="side__scroll">
        <SideItem
          current={query.view === "activity"}
          href={boardHref(query, {
            channel: null,
            thread: null,
            view: "activity",
          })}
          title="The newest messages of every channel"
        >
          Latest
        </SideItem>
        <SideItem
          count={data.open.length}
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
          title="All tasks by state. The number is the open tasks."
        >
          Tasks
        </SideItem>
        <SideItem
          alert
          count={blocked}
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
          title="Tasks that wait for an answer or a decision"
        >
          Needs a person
        </SideItem>
        <div class="side__head">
          <span class="label">Channels</span>
          <span class="spacer" />
          <button
            aria-expanded={adding}
            class="side__tool"
            onClick={toggle}
            title="New channel"
            type="button"
          >
            +
          </button>
        </div>
        {adding ? (
          <NewChannel onDone={done} query={query} run={props.run} />
        ) : null}
        {data.channels.length === 0 && !adding ? (
          <p class="side__empty">No channels yet. Make one with +.</p>
        ) : null}
        {channelGroups(data.channels).map(([group, channels]) => (
          <div class="side__group" key={group}>
            {group === "" ? null : (
              <span class="side__group-name">{group}</span>
            )}
            {channels.map((channel) => (
              <SideItem
                count={channel.open === 0 ? channel.threads : channel.open}
                current={query.channel === channel.path}
                href={boardHref(query, {
                  channel: channel.path,
                  thread: null,
                  view: query.view === "tasks" ? "tasks" : "channel",
                })}
                key={channel.path}
                title={`#${channel.path}${channel.open === 0 ? "" : ` · ${channel.open} open tasks`}`}
              >
                {`#${group === "" ? channel.path : channel.path.slice(group.length + 1)}`}
              </SideItem>
            ))}
          </div>
        ))}
      </nav>
      <div class="side__foot">
        <Avatar name={props.user} small />
        <span class="truncate">{`as ${props.user}`}</span>
      </div>
    </aside>
  );
};

// The main column

/** The open tasks of the board in a line, each a link to its list: `2 working · 3 to do · 1 needs a person`. */
const COUNTED: readonly TaskState[] = [
  "claimed",
  "ready",
  "blocked",
  "waiting",
];

const Counts = (props: {
  readonly now: number;
  readonly open: readonly MessageView[];
  readonly query: BoardQuery;
}) => {
  const counts = countStates(props.open, props.now);
  return (
    <span class="counts">
      {COUNTED.filter((state) => (counts[state] ?? 0) > 0).map((state) => (
        <a
          class={
            state === "blocked" && (counts.blocked ?? 0) > 0
              ? "counts__item counts__item--alert"
              : "counts__item"
          }
          href={boardHref(props.query, {
            channel: null,
            state,
            thread: null,
            view: "tasks",
          })}
          key={state}
          title={FILTER_HELP[state]}
        >
          <strong>{counts[state] ?? 0}</strong>
          {` ${FILTER_LABEL[state]}`}
        </a>
      ))}
    </span>
  );
};

export type Connection = "connecting" | "live" | "retrying";

const MainHead = (props: {
  readonly connection: Connection;
  readonly data: BoardData;
  readonly now: number;
  readonly onMenu: () => void;
  readonly query: BoardQuery;
}) => {
  const { query } = props;
  let title = "Latest";
  let meta = "the newest messages of every channel";
  if (query.view === "channel") {
    title = `#${query.channel ?? ""}`;
    meta = "threads by latest activity";
  } else if (query.view === "tasks") {
    title = query.channel === null ? "Tasks" : `#${query.channel}`;
    meta = FILTER_HELP[query.state];
  }
  const canSwitch = query.channel !== null && !query.channel.endsWith("/");
  return (
    <header class="col-head">
      <button
        aria-label="Channels"
        class="col-head__menu col-head__tool"
        onClick={props.onMenu}
        type="button"
      >
        ☰
      </button>
      <h1 class="col-head__title">{title}</h1>
      <span class="col-head__meta truncate">{meta}</span>
      {canSwitch && query.channel !== null ? (
        <ChannelAgents channel={query.channel} />
      ) : null}
      <span class="spacer" />
      {canSwitch ? (
        <nav aria-label="Channel view" class="switch">
          <a
            aria-current={query.view === "channel" ? "page" : undefined}
            href={boardHref(query, { thread: null, view: "channel" })}
          >
            Threads
          </a>
          <a
            aria-current={query.view === "tasks" ? "page" : undefined}
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
      <Counts now={props.now} open={props.data.open} query={query} />
      <span
        class={`live live--${props.connection}`}
        title="Board events come in as they happen"
      >
        {props.connection}
      </span>
    </header>
  );
};

/** A scrolling feed that keeps to the bottom while you are there, and holds still while you read. */
const Feed = (props: {
  readonly children: ComponentChildren;
  /** The newest item: when it changes, something new came in below. */
  readonly last: string;
  /** The view: when it changes, the feed goes to the bottom. */
  readonly scope: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const seen = useRef(props.last);
  const [behind, setBehind] = useState(false);
  const toBottom = () => {
    const element = ref.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
    pinned.current = true;
    setBehind(false);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new scope starts at the bottom.
  useLayoutEffect(toBottom, [props.scope]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new last item moves the feed.
  useLayoutEffect(() => {
    if (pinned.current) {
      toBottom();
    } else if (props.last !== seen.current) {
      setBehind(true);
    }
    seen.current = props.last;
  }, [props.last]);
  const scrolled = () => {
    const element = ref.current;
    if (element !== null) {
      pinned.current =
        element.scrollHeight - element.scrollTop - element.clientHeight <
        BOTTOM_SLACK_PX;
      if (pinned.current) {
        setBehind(false);
      }
    }
  };
  return (
    <div class="feed-wrap">
      <div class="feed" onScroll={scrolled} ref={ref}>
        {props.children}
      </div>
      {behind ? (
        <button class="feed__jump" onClick={toBottom} type="button">
          new messages ↓
        </button>
      ) : null}
    </div>
  );
};

const Where = (props: {
  readonly message: MessageView;
  readonly query: BoardQuery;
}) => (
  <span class="message__where">
    {props.message.re === null ? "in " : "replied in "}
    <a
      class="message__channel"
      href={boardHref(props.query, {
        channel: props.message.channel,
        thread: null,
        view: "channel",
      })}
    >{`#${props.message.channel}`}</a>
  </span>
);

const ActivityFeed = (props: {
  readonly messages: readonly MessageView[];
  readonly now: number;
  readonly query: BoardQuery;
}) => {
  const { now, query } = props;
  const item = (message: MessageView, continued: boolean) => {
    const thread = message.re ?? message.id;
    return (
      <Message
        context={<Where message={message} query={query} />}
        continued={continued}
        href={boardHref(query, { thread })}
        key={message.id}
        message={message}
        now={now}
        open={query.thread === thread}
        query={query}
      />
    );
  };
  return (
    <Feed
      last={props.messages.at(-1)?.id ?? ""}
      scope={boardHref(query, { thread: null })}
    >
      {props.messages.length === 0 ? (
        <p class="empty">
          Nothing on the board yet. Make a channel, then start a thread below.
        </p>
      ) : (
        <Timeline item={item} messages={props.messages} now={now} />
      )}
    </Feed>
  );
};

const ChannelFeed = (props: {
  readonly now: number;
  readonly query: BoardQuery;
  readonly threads: readonly ThreadSummaryView[];
}) => {
  const { now, query } = props;
  const summaries = new Map(
    props.threads.map((summary) => [summary.message.id, summary])
  );
  const item = (message: MessageView, continued: boolean) => {
    const summary = summaries.get(message.id);
    return (
      <Message
        continued={continued}
        href={boardHref(query, { thread: message.id })}
        key={message.id}
        message={message}
        now={now}
        open={query.thread === message.id}
        query={query}
        replies={{
          count: summary?.replies ?? 0,
          last: summary?.last ?? null,
        }}
      />
    );
  };
  // The board lists threads by latest activity, newest last: so does the feed.
  return (
    <Feed
      last={props.threads.at(-1)?.message.id ?? ""}
      scope={boardHref(query, { thread: null })}
    >
      {props.threads.length === 0 ? (
        <p class="empty">Nothing in this channel yet. Start a thread below.</p>
      ) : (
        <Timeline
          item={item}
          messages={props.threads.map((summary) => summary.message)}
          now={now}
        />
      )}
    </Feed>
  );
};

const StateTabs = (props: {
  readonly now: number;
  readonly open: readonly MessageView[];
  readonly query: BoardQuery;
}) => {
  const { query } = props;
  const counts: Partial<Record<TaskFilter, number>> = countStates(
    props.open.filter((root) => inFilter(root.channel, query.channel)),
    props.now
  );
  counts.open = Object.values(counts).reduce((sum, n) => sum + n, 0);
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
      {counts[filter] === undefined || counts[filter] === 0 ? null : (
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

/** The one thing about a task that matters now: who holds it, what it waits for, how it ended. */
const taskNow = (root: MessageView, now: number) => {
  const { task } = root;
  if (task === undefined) {
    return "";
  }
  switch (stateNow(task, now)) {
    case "claimed":
      return task.claim === null ? "" : `by ${actorName(task.claim.actor)}`;
    case "blocked":
      return task.blocked?.reason ?? "";
    case "waiting":
      return `needs ${task.needs.map((id) => `#${id}`).join(" ")}`;
    case "completed":
      return task.result ?? "";
    case "failed":
    case "canceled":
      return task.reason ?? "";
    default:
      return task.for === null ? "" : `for ${actorName(task.for)}`;
  }
};

const TaskRow = (props: {
  readonly now: number;
  readonly query: BoardQuery;
  readonly summary: ThreadSummaryView;
}) => {
  const { now, query } = props;
  const root = props.summary.message;
  const state = root.task === undefined ? null : stateNow(root.task, now);
  // In the list of one channel, each row would say the same channel.
  const oneChannel = query.channel !== null && !query.channel.endsWith("/");
  return (
    <a
      aria-current={query.thread === root.id ? "true" : undefined}
      class={oneChannel ? "task-row task-row--channel" : "task-row"}
      href={boardHref(query, { thread: root.id })}
    >
      <span class="task-row__state">
        {state === null ? null : <StateMark state={state} />}
      </span>
      <span class="task-row__title">
        <span class="muted mono">{`#${root.id}`}</span>
        <span class="truncate">{titleOf(root.text)}</span>
        {visibleLabels(root.labels).length > 0 ? (
          <Labels labels={root.labels} />
        ) : null}
      </span>
      <span class="task-row__now truncate">{taskNow(root, now)}</span>
      {oneChannel ? null : (
        <span class="task-row__where truncate">{`#${root.channel}`}</span>
      )}
      <span class="task-row__age">
        {shortAge(lastActive(props.summary), now)}
      </span>
    </a>
  );
};

const TaskGrid = (props: {
  readonly now: number;
  readonly open: readonly MessageView[];
  readonly query: BoardQuery;
  readonly tasks: readonly ThreadSummaryView[];
}) => (
  <>
    <StateTabs now={props.now} open={props.open} query={props.query} />
    <div class="grid-wrap">
      {props.tasks.length === 0 ? (
        <p class="empty">No tasks in this list.</p>
      ) : (
        props.tasks.map((summary) => (
          <TaskRow
            key={summary.message.id}
            now={props.now}
            query={props.query}
            summary={summary}
          />
        ))
      )}
    </div>
  </>
);

/** The composer of the main column: where it posts, and what it starts, by the view. */
const MainComposer = (props: {
  readonly data: BoardData;
  readonly onError: (message: string) => void;
  readonly onSent: (sent: Sent) => void;
  readonly query: BoardQuery;
}) => {
  const { data, query } = props;
  const known = knownLabels(data.open);
  const paths = data.channels.map((channel) => channel.path);
  const exact =
    query.channel !== null && !query.channel.endsWith("/")
      ? query.channel
      : undefined;
  if (query.view === "channel" && exact !== undefined) {
    return (
      <Composer
        channel={exact}
        known={known}
        onError={props.onError}
        onSent={props.onSent}
        placeholder={`message #${exact}…`}
        scope={`channel:${exact}`}
        tasks="toggle"
      />
    );
  }
  const tasks = query.view === "tasks";
  const inSubtree = paths.filter((path) => inFilter(path, query.channel));
  return (
    <Composer
      channels={inSubtree.length === 0 ? paths : inSubtree}
      known={known}
      onError={props.onError}
      onSent={props.onSent}
      placeholder="start a thread…"
      scope={tasks ? "tasks" : "activity"}
      tasks={tasks ? "always" : "toggle"}
      {...(exact === undefined ? {} : { channel: exact })}
    />
  );
};

export const BoardMain = (props: {
  readonly connection: Connection;
  readonly data: BoardData;
  readonly now: number;
  readonly onError: (message: string) => void;
  readonly onMenu: () => void;
  readonly onSent: (sent: Sent) => void;
  readonly query: BoardQuery;
}) => {
  const { data, now, query } = props;
  const { listing } = data;
  let body: ComponentChildren;
  if (listing.kind === "tasks") {
    body = (
      <TaskGrid
        now={now}
        open={data.open}
        query={query}
        tasks={listing.tasks}
      />
    );
  } else if (listing.kind === "threads") {
    body = <ChannelFeed now={now} query={query} threads={listing.threads} />;
  } else {
    body = <ActivityFeed messages={listing.messages} now={now} query={query} />;
  }
  return (
    <section class="board__main">
      <MainHead
        connection={props.connection}
        data={data}
        now={now}
        onMenu={props.onMenu}
        query={query}
      />
      {body}
      <MainComposer
        data={data}
        onError={props.onError}
        onSent={props.onSent}
        query={query}
      />
    </section>
  );
};

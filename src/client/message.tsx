import type { MessageView } from "@vercel/board";
import type { ComponentChildren, VNode } from "preact";
import { useEffect, useReducer } from "preact/hooks";
import {
  actorName,
  type BoardQuery,
  boardHref,
  continues,
  dayLabel,
  initialOf,
  isAgent,
  STATE_LABEL,
  STATE_MARK,
  sameDay,
  shortAge,
  stateNow,
  type TaskState,
  type TaskView,
  timeLeft,
  visibleLabels,
} from "./model.ts";

/** A URL in text, without the punctuation that ends its sentence. */
const URL_TEXT = /https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?]/g;

/** Text with its URLs as links. Preact escapes the rest. */
export const Linked = (props: { readonly text: string }) => {
  const parts: (string | VNode)[] = [];
  let from = 0;
  for (const match of props.text.matchAll(URL_TEXT)) {
    const [url] = match;
    parts.push(props.text.slice(from, match.index));
    parts.push(
      <a href={url} key={match.index} rel="noopener" target="_blank">
        {url}
      </a>
    );
    from = match.index + url.length;
  }
  parts.push(props.text.slice(from));
  return <>{parts}</>;
};

const FENCE = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
const MARKED = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/;

/** A line of text with `code` and **strong** words, and its URLs as links. */
export const Inline = (props: { readonly text: string }) => {
  let at = 0;
  return (
    <>
      {props.text.split(MARKED).map((part) => {
        const key = at;
        at += part.length;
        if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
          return <code key={key}>{part.slice(1, -1)}</code>;
        }
        if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
          return <strong key={key}>{part.slice(2, -2)}</strong>;
        }
        return <Linked key={key} text={part} />;
      })}
    </>
  );
};

/**
 * The text of a message: agents write Markdown, so a fenced block shows as code, and `code` and
 * **strong** words show as such. All other text shows as it was written.
 */
export const Rich = (props: { readonly text: string }) => {
  const blocks: VNode[] = [];
  let from = 0;
  for (const match of props.text.matchAll(FENCE)) {
    const before = props.text.slice(from, match.index).trim();
    if (before !== "") {
      blocks.push(<Inline key={`text-${from}`} text={before} />);
    }
    blocks.push(
      <pre class="message__code" key={`code-${match.index}`}>
        {(match[1] ?? "").trimEnd()}
      </pre>
    );
    from = match.index + match[0].length;
  }
  const rest = props.text.slice(from).trim();
  if (rest !== "") {
    blocks.push(<Inline key={`text-${from}`} text={rest} />);
  }
  return <>{blocks}</>;
};

/** A message of more lines or letters than this is cut in a feed: its thread shows all of it. */
const FEED_LINES = 12;
const FEED_LETTERS = 900;

export const cutForFeed = (text: string) => {
  const lines = text.split("\n");
  const cut =
    lines.length > FEED_LINES
      ? lines.slice(0, FEED_LINES).join("\n")
      : text.slice(0, FEED_LETTERS);
  return cut.length < text.length ? cut : null;
};

export const Avatar = (props: {
  /** An agent of Factory has a filled avatar. */
  readonly agent?: boolean;
  readonly name: string;
  readonly small?: boolean;
}) => {
  const classes = ["avatar"];
  if (props.small === true) {
    classes.push("avatar--small");
  }
  if (props.agent === true) {
    classes.push("avatar--agent");
  }
  return (
    <span aria-hidden="true" class={classes.join(" ")}>
      {initialOf(props.name)}
    </span>
  );
};

/** A task's state with its mark: `○ to do`. The board's own word is in the tooltip. */
export const StateMark = (props: { readonly state: TaskState }) => (
  <span
    class={`task-state task-state--${props.state}`}
    title={`Board state: ${props.state}`}
  >
    <span aria-hidden="true">{STATE_MARK[props.state]}</span>
    {STATE_LABEL[props.state]}
  </span>
);

/** The time left of a claim, counted down each second. */
export const Lease = (props: { readonly until: string }) => {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  const now = Date.now();
  return (
    <span
      class="lease"
      title={`until ${new Date(props.until).toLocaleString()}`}
    >
      {Date.parse(props.until) > now
        ? `${timeLeft(props.until, now)} left`
        : "the claim ran out"}
    </span>
  );
};

/** A task in a line, under its root: state, who holds it and for how long, who it is for, what it waits for, how it ended. */
export const TaskLine = (props: {
  readonly now: number;
  readonly query: BoardQuery;
  readonly task: TaskView;
}) => {
  const { now, query, task } = props;
  const state = stateNow(task, now);
  const lapsed = task.state === "claimed" && state !== "claimed";
  const finished =
    state === "completed" || state === "failed" || state === "canceled";
  let note: string | null = null;
  if (state === "blocked" && task.blocked !== null) {
    note = `${task.blocked.kind ? `${task.blocked.kind}: ` : ""}${task.blocked.reason}`;
  } else if (state === "completed") {
    note = task.result;
  } else if (state === "failed" || state === "canceled") {
    note = task.reason;
  }
  return (
    <div class="task-line">
      <StateMark state={state} />
      {state === "claimed" && task.claim !== null ? (
        <>
          <span>{`by ${actorName(task.claim.actor)}`}</span>
          <Lease until={task.claim.until} />
        </>
      ) : null}
      {lapsed ? <span class="lease">the claim ran out</span> : null}
      {task.for !== null && !finished ? (
        <span>{`for ${actorName(task.for)}`}</span>
      ) : null}
      {task.needs.length > 0 && !finished ? (
        <span>
          {"needs "}
          {task.needs.map((id) => (
            <a class="need" href={boardHref(query, { thread: id })} key={id}>
              {`#${id}`}
            </a>
          ))}
        </span>
      ) : null}
      {note === null || note === "" ? null : (
        <span class="task-line__note">
          <Inline text={note} />
        </span>
      )}
    </div>
  );
};

/** Factory's own labels as words: where a task came from, and which agent it is for. */
const FactoryLabel = (props: {
  readonly name: string;
  readonly query: BoardQuery | undefined;
  readonly value: string;
}) => {
  if (props.name === "factory.from") {
    return (
      <a
        class="tag tag--muted"
        href={
          props.query === undefined
            ? `/board/tasks/${props.value}`
            : boardHref(props.query, { thread: props.value })
        }
        title="The task that this task came from"
      >{`from #${props.value}`}</a>
    );
  }
  return (
    <span class="tag tag--muted">
      {props.name === "factory.agent" ? `for ${props.value}` : "scheduled"}
    </span>
  );
};

export const Labels = (props: {
  readonly labels: Readonly<Record<string, string>>;
  readonly query?: BoardQuery;
}) => {
  const labels = visibleLabels(props.labels);
  return labels.length === 0 ? null : (
    <div class="labels">
      {labels.map(([key, value]) =>
        key.startsWith("factory.") ? (
          <FactoryLabel
            key={key}
            name={key}
            query={props.query}
            value={value}
          />
        ) : (
          <span class="tag" key={key}>{`${key}=${value}`}</span>
        )
      )}
    </div>
  );
};

const Attachments = (props: { readonly message: MessageView }) =>
  props.message.attachments.length === 0 ? null : (
    <div class="labels">
      {props.message.attachments.map((file) => (
        <a
          class="tag tag--muted"
          href={`/api/board/attachments/${encodeURIComponent(file.id)}`}
          key={file.id}
          rel="noopener"
          target="_blank"
        >
          {`📎 ${file.name}`}
        </a>
      ))}
    </div>
  );

/** The text of a message. In a feed a long text is cut, with a link to its thread. */
const MessageText = (props: {
  readonly href: string | null;
  readonly text: string;
}) => {
  const cut = props.href === null ? null : cutForFeed(props.text);
  return (
    <div class="message__text">
      <Rich text={cut ?? props.text} />
      {cut === null || props.href === null ? null : (
        <a class="message__more" href={props.href}>
          {`… ${props.text.split("\n").length} lines. Open the thread to read all.`}
        </a>
      )}
    </div>
  );
};

/**
 * One message, as the Board viewer shows it: an avatar, the author, where and when, the text, the task line of a
 * task, the labels, and below a thread's root, its replies. A continued message (same author, a few minutes
 * later) leaves out the avatar and the author.
 */
export const Message = (props: {
  /** After the author: `in #dev`, `replied in #dev`. */
  readonly context?: ComponentChildren;
  readonly continued?: boolean;
  /** Where the message opens: its thread in the pane. Null: it is the open thread. */
  readonly href: string | null;
  readonly message: MessageView;
  readonly now: number;
  readonly open?: boolean;
  readonly query: BoardQuery;
  readonly replies?: {
    readonly count: number;
    readonly last: MessageView | null;
  };
  /** False on the root of the open thread: its task card shows the task. */
  readonly taskLine?: boolean;
}) => {
  const { message, now } = props;
  const name = actorName(message.by.actor);
  const created = Date.parse(message.createdAt);
  const time = new Date(created).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const classes = ["message"];
  if (props.continued === true) {
    classes.push("message--continued");
  }
  if (props.open === true) {
    classes.push("message--open");
  }
  return (
    <article class={classes.join(" ")} id={`m${message.id}`}>
      <div class="message__gutter">
        {props.continued === true ? (
          <time class="message__time" dateTime={message.createdAt}>
            {time}
          </time>
        ) : (
          <Avatar agent={isAgent(message.by.actor)} name={name} />
        )}
      </div>
      <div class="message__body">
        {props.continued === true ? null : (
          <div class="message__meta">
            <strong class="message__author">{name}</strong>
            {props.context}
            <time
              class="message__age"
              dateTime={message.createdAt}
              title={new Date(created).toLocaleString()}
            >
              {shortAge(created, now)}
            </time>
            <span class="spacer" />
            {props.href === null ? (
              <span class="message__id">{`#${message.id}`}</span>
            ) : (
              <a class="message__id" href={props.href} title="Open the thread">
                {`#${message.id}`}
              </a>
            )}
          </div>
        )}
        {message.deleted ? (
          <p class="message__removed">message removed</p>
        ) : (
          <MessageText href={props.href} text={message.text} />
        )}
        <Attachments message={message} />
        {message.task === undefined ||
        message.deleted ||
        props.taskLine === false ? null : (
          <TaskLine now={now} query={props.query} task={message.task} />
        )}
        <Labels labels={message.labels} query={props.query} />
        {props.replies === undefined ||
        props.replies.count === 0 ||
        props.href === null ? null : (
          <a class="message__replies" href={props.href}>
            {props.replies.last === null ? null : (
              <Avatar
                agent={isAgent(props.replies.last.by.actor)}
                name={actorName(props.replies.last.by.actor)}
                small
              />
            )}
            {`${props.replies.count} ${props.replies.count === 1 ? "reply" : "replies"}`}
            {props.replies.last === null
              ? null
              : ` · last ${shortAge(Date.parse(props.replies.last.createdAt), now)}`}
          </a>
        )}
      </div>
    </article>
  );
};

/**
 * Messages oldest first, with a divider at each new day, and messages from one author in a row as one block.
 * `item` renders one message, given whether it continues the one before.
 */
export const Timeline = (props: {
  readonly item: (message: MessageView, continued: boolean) => VNode;
  readonly messages: readonly MessageView[];
  readonly now: number;
}) => {
  const rows: VNode[] = [];
  let previous: MessageView | undefined;
  for (const message of props.messages) {
    const created = Date.parse(message.createdAt);
    const newDay =
      previous === undefined ||
      !sameDay(Date.parse(previous.createdAt), created);
    if (newDay) {
      rows.push(
        <div class="divider" key={`day-${message.id}`}>
          {dayLabel(created, props.now)}
        </div>
      );
    }
    rows.push(props.item(message, !newDay && continues(previous, message)));
    previous = message;
  }
  return <>{rows}</>;
};

import type { MessageView, ThreadView } from "@vercel/board";
import type { ComponentChildren, VNode } from "preact";
import { ApiError, get, post } from "./api.ts";
import { fieldOf, type Run, sendOnEnter } from "./board.tsx";
import {
  actorName,
  type BoardQuery,
  boardHref,
  formatAgo,
  STATE_LABEL,
  STATE_MARK,
  stateNow,
  type TaskState,
  timeLeft,
  titleOf,
  visibleLabels,
  withoutTitle,
} from "./model.ts";

const REPLY_LIMIT = 500;
/** A person's claim to complete a task: only long enough for the complete that follows it. */
const COMPLETE_LEASE_SECONDS = 60;

export interface ThreadData {
  /** The tasks it waits for, with their states. */
  readonly needs: ReadonlyArray<{
    readonly id: string;
    readonly state: string;
  }>;
  readonly thread: ThreadView;
}

/** A thread and the states of the tasks it waits for, or null when the board has no such message. */
export const loadThread = async (id: string): Promise<ThreadData | null> => {
  try {
    const thread = await get<ThreadView>(`/messages/${id}`, {
      limit: REPLY_LIMIT,
    });
    const needs = await Promise.all(
      (thread.message.task?.needs ?? []).map((need) =>
        get<ThreadView>(`/messages/${need}`, { limit: 1 })
          .then((view) => ({
            id: need,
            state: view.message.task?.state ?? "thread",
          }))
          .catch(() => ({ id: need, state: "unknown" }))
      )
    );
    return { needs, thread };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
};

/** A URL in text, without the punctuation that ends its sentence. */
const URL_TEXT = /https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?]/g;

/** Text with its URLs as links. Preact escapes the rest. */
const Linked = (props: { readonly text: string }) => {
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

const TaskStateMark = (props: { readonly state: TaskState }) => (
  <span
    class={`task-state task-state--${props.state}`}
    title={`Board state: ${props.state}`}
  >
    <span aria-hidden="true">{STATE_MARK[props.state]}</span>
    {STATE_LABEL[props.state]}
  </span>
);

const Message = (props: {
  readonly message: MessageView;
  readonly now: number;
  /** The text to show, when not the whole message: the root without its title. */
  readonly text?: string;
}) => {
  const { message } = props;
  const text = message.deleted ? "(deleted)" : (props.text ?? message.text);
  const labels = visibleLabels(message.labels);
  return (
    <article class="message" id={`m${message.id}`}>
      <header class="row small row--tight">
        <strong>{actorName(message.by.actor)}</strong>
        <time
          class="muted"
          dateTime={message.createdAt}
          title={message.createdAt}
        >
          {formatAgo(Date.parse(message.createdAt), props.now)}
        </time>
        <span class="spacer" />
        <span class="muted mono">{`#${message.id}`}</span>
      </header>
      {text === "" ? null : (
        <div class="message__text">
          <Linked text={text} />
        </div>
      )}
      {message.attachments.length === 0 ? null : (
        <div class="row small row--tight">
          {message.attachments.map((file) => (
            <a
              class="tag"
              href={`/api/board/attachments/${encodeURIComponent(file.id)}`}
              key={file.id}
              rel="noopener"
              target="_blank"
            >
              {`📎 ${file.name}`}
            </a>
          ))}
        </div>
      )}
      {labels.length === 0 ? null : (
        <div class="row small row--tight">
          {labels.map(([key, value]) => (
            <span class="tag" key={key}>{`${key}=${value}`}</span>
          ))}
        </div>
      )}
    </article>
  );
};

const Fact = (props: {
  readonly children: ComponentChildren;
  readonly label: string;
}) => (
  <>
    <dt class="label">{props.label}</dt>
    <dd>{props.children}</dd>
  </>
);

const TaskFacts = (props: {
  readonly data: ThreadData;
  readonly now: number;
  readonly query: BoardQuery;
}) => {
  const root = props.data.thread.message;
  const { task } = root;
  return (
    <dl class="facts small">
      <Fact label="Created by">{actorName(root.by.actor)}</Fact>
      {task?.claim && stateNow(task, props.now) === "claimed" ? (
        <Fact label="Claimed by">
          {`${actorName(task.claim.actor)} · the claim ends in ${timeLeft(task.claim.until, props.now)}`}
        </Fact>
      ) : null}
      {props.data.needs.length > 0 ? (
        <Fact label="Starts after">
          {props.data.needs.map((need) => (
            <span class="needs" key={need.id}>
              <a
                href={boardHref(props.query, { thread: need.id })}
              >{`#${need.id}`}</a>
              {` ${STATE_LABEL[need.state as TaskState] ?? need.state}`}
            </span>
          ))}
        </Fact>
      ) : null}
      {task?.blocked ? (
        <Fact label="Why">
          <span class="tag">{task.blocked.kind ?? "held"}</span>{" "}
          <Linked text={task.blocked.reason} />
        </Fact>
      ) : null}
      {task?.result ? (
        <Fact label="Result">
          <Linked text={task.result} />
        </Fact>
      ) : null}
      {task?.reason ? (
        <Fact label="Reason">
          <Linked text={task.reason} />
        </Fact>
      ) : null}
    </dl>
  );
};

const FINISHED = new Set<TaskState>(["canceled", "completed", "failed"]);

/** What happens to the task next, or what a person does now. */
const nextStep = (root: MessageView, now: number) => {
  const { task } = root;
  if (task === undefined) {
    return "A thread is a note or a discussion: no one must do it. Make it a task to track it.";
  }
  switch (stateNow(task, now)) {
    case "waiting":
      return "It starts when the tasks it waits for are done.";
    case "ready":
      return "Do the task, reply with what you did, then mark it done.";
    case "claimed":
      return "A claim holds the task. It is free again when the claim ends.";
    case "blocked":
      return "It waits for a person. Reply, then continue the task.";
    case "failed":
      return "Reopen puts the task back in the list of tasks to do.";
    case "canceled":
      return "A canceled task cannot be reopened. Create a new task when the work is still necessary.";
    default:
      return null;
  }
};

/** A person completes a task with a short claim of their own: unblock it first when it is held. */
const complete = async (root: MessageView, user: string) => {
  if (root.task?.state === "blocked") {
    await post(`/tasks/${root.id}/unblock`);
  }
  const { claim } = await post<{ claim: { epoch: number; token: string } }>(
    `/tasks/${root.id}/claim`,
    { lease: COMPLETE_LEASE_SECONDS }
  );
  await post(`/tasks/${root.id}/complete`, {
    epoch: claim.epoch,
    result: `Done (${user})`,
    token: claim.token,
  });
};

const ACTION_LABEL = {
  cancel: "Cancel task",
  complete: "Mark done",
  "make-task": "Make it a task",
  reopen: "Reopen task",
  unblock: "Continue task",
} as const;

type TaskAction = keyof typeof ACTION_LABEL;

const ACTION_TONE: Record<TaskAction, "danger" | "primary" | "secondary"> = {
  cancel: "danger",
  complete: "secondary",
  "make-task": "primary",
  reopen: "primary",
  unblock: "primary",
};

/** The actions a person can take on a thread now. The board reopens only a failed task. */
const actionsOf = (root: MessageView): TaskAction[] => {
  const state = root.task?.state;
  if (state === undefined) {
    return ["make-task"];
  }
  const actions: TaskAction[] = [];
  if (state === "blocked") {
    actions.push("unblock");
  }
  if (state === "failed") {
    actions.push("reopen");
  }
  // The board refuses a claim on a task that waits or is held.
  if (!(FINISHED.has(state) || state === "claimed" || state === "waiting")) {
    actions.push("complete");
  }
  if (!FINISHED.has(state)) {
    actions.push("cancel");
  }
  return actions;
};

const writeOf = (action: TaskAction, root: MessageView, user: string) => {
  switch (action) {
    case "make-task":
      return () => post("/tasks", { re: root.id });
    case "unblock":
    case "reopen":
      return () => post(`/tasks/${root.id}/${action}`);
    case "complete":
      return () => complete(root, user);
    default:
      return () =>
        post(`/tasks/${root.id}/cancel`, { reason: `Canceled by ${user}` });
  }
};

/** What a person can do to the task now: one button for each action. */
const TaskActions = (props: {
  readonly root: MessageView;
  readonly run: Run;
  readonly user: string;
}) => {
  const act = (event: SubmitEvent) => {
    event.preventDefault();
    const action = (event.submitter as HTMLButtonElement | null)?.value as
      | TaskAction
      | undefined;
    if (action === undefined) {
      return;
    }
    if (
      action === "cancel" &&
      // biome-ignore lint/suspicious/noAlert: a native confirm before a write that cannot be undone.
      !confirm("Cancel this task? A canceled task cannot be reopened.")
    ) {
      return;
    }
    props.run(writeOf(action, props.root, props.user));
  };
  return (
    <form class="pane__actions" onSubmit={act}>
      {actionsOf(props.root).map((action) => (
        <button
          class={`button button--small button--${ACTION_TONE[action]}`}
          key={action}
          type="submit"
          value={action}
        >
          {ACTION_LABEL[action]}
        </button>
      ))}
    </form>
  );
};

const ReplyForm = (props: {
  readonly root: MessageView;
  readonly run: Run;
}) => {
  const blocked = props.root.task?.state === "blocked";
  const send = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const unblock = blocked && new FormData(form).get("unblock") === "on";
    const sent = await props.run(async () => {
      await post("/messages", {
        re: props.root.id,
        text: fieldOf(form, "text"),
      });
      if (unblock) {
        await post(`/tasks/${props.root.id}/unblock`);
      }
    });
    if (sent) {
      form.reset();
    }
  };
  return (
    <form class="composer composer--reply" onSubmit={send}>
      <div class="composer__box">
        <textarea
          aria-label="Reply"
          class="textarea composer__text"
          name="text"
          onKeyDown={sendOnEnter}
          placeholder={blocked ? "Answer, or say what to do next…" : "Reply…"}
          required
        />
        <div class="composer__bar">
          {blocked ? (
            <label class="row small row--tight">
              <input defaultChecked name="unblock" type="checkbox" />
              Continue task after reply
            </label>
          ) : null}
          <span class="spacer" />
          <button class="button button--primary button--small" type="submit">
            Send reply
          </button>
        </div>
      </div>
    </form>
  );
};

/** The pane of the open thread: the task, what to do with it, its thread, and the reply form. */
export const TaskPane = (props: {
  readonly data: ThreadData | null;
  readonly now: number;
  readonly query: BoardQuery;
  readonly run: Run;
  readonly user: string;
}) => {
  const { data, now, query } = props;
  const close = boardHref(query, { thread: null });
  if (data === null) {
    return (
      <div class="pane__live">
        <header class="pane__head">
          <span class="label">Thread</span>
          <span class="spacer" />
          <a aria-label="Close" class="pane__close" href={close}>
            ×
          </a>
        </header>
        <div class="pane__scroll">
          <p class="hint pane__section">No such thread.</p>
        </div>
      </div>
    );
  }
  const root = data.thread.message;
  const { replies } = data.thread;
  const state = root.task === undefined ? null : stateNow(root.task, now);
  const next = nextStep(root, now);
  const rootBody = withoutTitle(root.text);
  const showRoot =
    rootBody !== "" ||
    root.attachments.length > 0 ||
    visibleLabels(root.labels).length > 0;
  return (
    <>
      <div class="pane__live">
        <header class="pane__head">
          <a class="label" href={`/board/tasks/${root.id}`} title="Permalink">
            {`${root.task === undefined ? "Thread" : "Task"} #${root.id}`}
          </a>
          <a
            class="mono small muted"
            href={boardHref(query, {
              channel: root.channel,
              thread: null,
              view: "channel",
            })}
          >
            {`#${root.channel}`}
          </a>
          {state === null ? null : <TaskStateMark state={state} />}
          <span class="spacer" />
          <a aria-label="Close" class="pane__close" href={close}>
            ×
          </a>
        </header>
        <div class="pane__scroll">
          <div class="pane__section pane__task">
            <h2 class="pane__title">{titleOf(root.text)}</h2>
            <TaskActions root={root} run={props.run} user={props.user} />
            {next === null ? null : (
              <p
                class={
                  state === "blocked"
                    ? "pane__next pane__next--warn"
                    : "pane__next"
                }
              >
                {next}
              </p>
            )}
            <TaskFacts data={data} now={now} query={query} />
          </div>
          <div class="thread">
            {showRoot ? (
              <Message message={root} now={now} text={rootBody} />
            ) : null}
            {replies.length === 0 ? null : (
              <span class="thread__count label">
                {`${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
              </span>
            )}
            {replies.map((reply) => (
              <Message key={reply.id} message={reply} now={now} />
            ))}
          </div>
        </div>
      </div>
      <ReplyForm key={root.id} root={root} run={props.run} />
    </>
  );
};

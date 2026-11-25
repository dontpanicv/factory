import type { MessageView, ThreadView } from "@vercel/board";
import { type ComponentChildren, Fragment } from "preact";
import { useState } from "preact/hooks";
import { TaskRuns } from "../../agents/client/run.tsx";
import { ApiError, get, post } from "../../shared/client/api.ts";
import { Inline } from "../../shared/client/text.tsx";
import { fieldOf, type Run } from "./board.tsx";
import { Composer, type Sent } from "./composer.tsx";
import { Lease, Message, StateMark, Timeline } from "./message.tsx";
import {
  actorName,
  type BoardQuery,
  boardHref,
  STATE_LABEL,
  stateNow,
  type TaskState,
  titleOf,
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

const Fact = (props: {
  readonly children: ComponentChildren;
  readonly label: string;
}) => (
  <>
    <dt>{props.label}</dt>
    <dd>{props.children}</dd>
  </>
);

const FINISHED = new Set<TaskState>(["canceled", "completed", "failed"]);

/** A person completes a task with a short claim of their own: unblock it first when it is held. */
const complete = async (root: MessageView, result: string) => {
  if (root.task?.state === "blocked") {
    await post(`/tasks/${root.id}/unblock`);
  }
  const { claim } = await post<{ claim: { epoch: number; token: string } }>(
    `/tasks/${root.id}/claim`,
    { lease: COMPLETE_LEASE_SECONDS }
  );
  await post(`/tasks/${root.id}/complete`, {
    epoch: claim.epoch,
    ...(result === "" ? {} : { result }),
    token: claim.token,
  });
};

/** The actions that ask for a text first. */
type Asked = "block" | "cancel" | "complete";

const ASK: Record<
  Asked,
  {
    readonly button: string;
    readonly placeholder: string;
    readonly required: boolean;
  }
> = {
  block: {
    button: "Hold it",
    placeholder: "what it waits for from a person",
    required: true,
  },
  cancel: {
    button: "Cancel the task",
    placeholder: "why it is canceled",
    required: true,
  },
  complete: {
    button: "Mark done",
    placeholder: "the result (optional)",
    required: false,
  },
};

/** What a person can do to a task now. The board reopens only a failed task. */
const TaskActions = (props: {
  readonly root: MessageView;
  readonly run: Run;
}) => {
  const { root, run } = props;
  const [asking, setAsking] = useState<Asked | null>(null);
  const state = root.task === undefined ? null : root.task.state;
  const pick = (event: MouseEvent) => {
    const button = event.currentTarget as HTMLButtonElement;
    const action = button.value;
    if (action === "unblock" || action === "reopen") {
      run(() => post(`/tasks/${root.id}/${action}`));
    } else if (action === "make-task") {
      run(() => post("/tasks", { re: root.id }));
    } else {
      setAsking(action as Asked);
    }
  };
  const stop = () => setAsking(null);
  const send = async (event: SubmitEvent) => {
    event.preventDefault();
    const text = fieldOf(event.currentTarget as HTMLFormElement, "text");
    const write = {
      block: () =>
        post(`/tasks/${root.id}/block`, { kind: "needs_input", reason: text }),
      cancel: () => post(`/tasks/${root.id}/cancel`, { reason: text }),
      complete: () => complete(root, text),
    };
    if (asking !== null && (await run(write[asking]))) {
      setAsking(null);
    }
  };
  const buttons: Array<{ action: string; label: string; primary?: boolean }> =
    [];
  if (state === null) {
    buttons.push({
      action: "make-task",
      label: "Make it a task",
      primary: true,
    });
  } else {
    if (state === "blocked") {
      buttons.push({ action: "unblock", label: "Continue", primary: true });
    }
    if (state === "failed") {
      buttons.push({ action: "reopen", label: "Reopen", primary: true });
    }
    // The board refuses a claim on a task that waits or is held by someone.
    if (!(FINISHED.has(state) || state === "claimed" || state === "waiting")) {
      buttons.push({
        action: "complete",
        label: "Done…",
        primary: state !== "blocked",
      });
    }
    if (state === "ready") {
      buttons.push({ action: "block", label: "Hold for a person…" });
    }
    if (!FINISHED.has(state)) {
      buttons.push({ action: "cancel", label: "Cancel…" });
    }
  }
  if (asking !== null) {
    const ask = ASK[asking];
    return (
      <form class="ask" key={asking} onSubmit={send}>
        <input
          aria-label={ask.placeholder}
          autoFocus
          class="input"
          name="text"
          placeholder={ask.placeholder}
          required={ask.required}
        />
        <button
          class={`button button--small ${asking === "cancel" ? "button--danger" : "button--primary"}`}
          type="submit"
        >
          {ask.button}
        </button>
        <button
          class="button button--small button--secondary"
          onClick={stop}
          type="button"
        >
          Back
        </button>
      </form>
    );
  }
  return buttons.length === 0 ? null : (
    <div class="card-actions">
      {buttons.map((button) => (
        <button
          class={`button button--small ${button.primary === true ? "button--primary" : "button--secondary"}`}
          key={button.action}
          onClick={pick}
          type="button"
          value={button.action}
        >
          {button.label}
        </button>
      ))}
    </div>
  );
};

/** A task in full, at the top of its thread: its facts, and what a person can do to it now. */
const TaskCard = (props: {
  readonly data: ThreadData;
  readonly now: number;
  readonly query: BoardQuery;
  readonly run: Run;
}) => {
  const root = props.data.thread.message;
  const { task } = root;
  if (task === undefined) {
    return (
      <section class="task-card">
        <p class="task-card__hint">
          A thread is a note or a discussion: no one must do it. Make it a task
          to track it.
        </p>
        <TaskActions root={root} run={props.run} />
      </section>
    );
  }
  const state = stateNow(task, props.now);
  return (
    <section class="task-card">
      <div class="task-card__head">
        <StateMark state={state} />
        <h2 class="task-card__title">{titleOf(root.text)}</h2>
      </div>
      <dl class="task-card__facts">
        <Fact label="owner">{actorName(task.owner)}</Fact>
        {state === "claimed" && task.claim !== null ? (
          <Fact label="held by">
            {`${actorName(task.claim.actor)} · `}
            <Lease until={task.claim.until} />
          </Fact>
        ) : null}
        {task.for === null ? null : (
          <Fact label="for">{actorName(task.for)}</Fact>
        )}
        {props.data.needs.length === 0 ? null : (
          <Fact label="needs">
            {props.data.needs.map((need) => (
              <a
                class="need"
                href={boardHref(props.query, { thread: need.id })}
                key={need.id}
              >
                {`#${need.id} ${STATE_LABEL[need.state as TaskState] ?? need.state}`}
              </a>
            ))}
          </Fact>
        )}
        {task.blocked === null ? null : (
          <Fact label="held">
            {task.blocked.kind ? (
              <span class="tag">{task.blocked.kind}</span>
            ) : null}{" "}
            <Inline text={task.blocked.reason} />
          </Fact>
        )}
        {task.result ? (
          <Fact label="result">
            <Inline text={task.result} />
          </Fact>
        ) : null}
        {task.reason ? (
          <Fact label="reason">
            <Inline text={task.reason} />
          </Fact>
        ) : null}
      </dl>
      <TaskActions root={root} run={props.run} />
      <TaskRuns now={props.now} stamp={props.data} taskId={root.id} />
    </section>
  );
};

/** The pane of the open thread: the task card, the thread, and the reply composer. */
export const ThreadPane = (props: {
  readonly data: ThreadData | null;
  /** The labels in use, as `key=value`, for the composer's suggestions. */
  readonly known: readonly string[];
  readonly now: number;
  readonly onError: (message: string) => void;
  readonly onSent: (sent: Sent) => void;
  readonly query: BoardQuery;
  readonly run: Run;
}) => {
  const { data, now, query } = props;
  const close = boardHref(query, { thread: null });
  const root = data?.thread.message ?? null;
  const replies = data?.thread.replies ?? [];
  // The root and its replies in one timeline, so a day divider shows once; the reply count follows the root.
  const item = (message: MessageView, continued: boolean) =>
    message === root ? (
      <Fragment key={message.id}>
        <Message
          href={null}
          message={message}
          now={now}
          query={query}
          taskLine={false}
        />
        {replies.length === 0 ? null : (
          <div class="divider">
            {`${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
          </div>
        )}
      </Fragment>
    ) : (
      <Message
        continued={continued}
        href={null}
        key={message.id}
        message={message}
        now={now}
        query={query}
      />
    );
  return (
    <aside class="board__pane">
      <header class="col-head">
        <h2 class="col-head__title">
          {root?.task === undefined ? "Thread" : `Task #${root.id}`}
        </h2>
        {root === null ? null : (
          <a
            class="col-head__meta"
            href={boardHref(query, {
              channel: root.channel,
              thread: null,
              view: "channel",
            })}
          >{`in #${root.channel}`}</a>
        )}
        <span class="spacer" />
        {root === null ? null : (
          <a
            class="col-head__tool"
            href={`/board/tasks/${root.id}`}
            title="Permalink"
          >
            ¶
          </a>
        )}
        <a
          aria-label="Close"
          class="col-head__tool"
          href={close}
          title="Close (Esc)"
        >
          ×
        </a>
      </header>
      {data === null || root === null ? (
        <p class="empty">No such thread.</p>
      ) : (
        <>
          <div class="pane__scroll">
            <TaskCard data={data} now={now} query={query} run={props.run} />
            <Timeline item={item} messages={[root, ...replies]} now={now} />
          </div>
          <Composer
            continues={root.task?.state === "blocked"}
            key={root.id}
            known={props.known}
            onError={props.onError}
            onSent={props.onSent}
            placeholder="reply to thread…"
            re={root.id}
            scope={`thread:${root.id}`}
            tasks="never"
          />
        </>
      )}
    </aside>
  );
};

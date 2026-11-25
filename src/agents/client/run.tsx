import { useEffect, useState } from "preact/hooks";
import { get, post } from "../../shared/client/api.ts";
import { ChevronDown } from "../../shared/client/icons.tsx";
import { type AgentRun, FACTORY } from "../../shared/client/overview.ts";
import { Inline, Rich } from "../../shared/client/text.tsx";
import { duration } from "../../shared/client/time.ts";
import { RunChip, RunTable } from "./agents.tsx";
import { LIVE_STATES } from "./runs.ts";

/** What an agent did on a task: the run's result, then each step in one line. */

interface Step {
  readonly at: number;
  readonly failed: boolean;
  readonly kind: "say" | "tool";
  readonly output: string;
  readonly text: string;
  readonly tool: string;
}

interface RunView {
  readonly run: AgentRun;
  readonly steps: readonly Step[];
}

const POLL_MS = 2000;
const THOUSAND = 1000;

const clock = (at: number) =>
  at === 0
    ? ""
    : new Date(at).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

const StepRow = (props: { readonly step: Step }) => {
  const { step } = props;
  if (step.kind === "say") {
    return (
      <li
        class={step.failed ? "step step--say step--failed" : "step step--say"}
      >
        <span class="step__time">{clock(step.at)}</span>
        <div class="step__text">
          <Rich text={step.text} />
        </div>
      </li>
    );
  }
  return (
    <li class={step.failed ? "step step--failed" : "step"}>
      <span class="step__time">{clock(step.at)}</span>
      <details class="step__tool">
        <summary>
          <span class="caret">
            <ChevronDown />
          </span>
          <span class="step__name">{step.tool}</span>
          <code class="truncate">{step.text.replaceAll("\n", " ↵ ")}</code>
          {step.failed ? <span class="step__flag">failed</span> : null}
        </summary>
        <pre class="log">{`${step.text.includes("\n") ? `${step.text}\n\n` : ""}${step.output || "(no output)"}`}</pre>
      </details>
    </li>
  );
};

export const RunPage = (props: {
  readonly id: string;
  readonly now: number;
}) => {
  const [view, setView] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = view === null || LIVE_STATES.includes(view.run.state);
  useEffect(() => {
    const load = () =>
      get<RunView>(`${FACTORY}/runs/${props.id}`)
        .then(setView)
        .catch((failure: Error) => setError(failure.message));
    load();
    if (!live) {
      return;
    }
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [props.id, live]);
  const stop = () => {
    post(`${FACTORY}/runs/${props.id}/stop`).catch((failure: Error) =>
      setError(failure.message)
    );
  };
  if (view === null) {
    return <p class="empty">{error ?? "Loading…"}</p>;
  }
  const { run, steps } = view;
  const tools = steps.filter((step) => step.kind === "tool");
  return (
    <div class="fpage fpage--narrow stack">
      <div class="page-head page-head--tight">
        <div>
          <span class="eyebrow">
            <a href={`/agents/${run.agent}`}>{run.agent}</a>
            {" worked on "}
            <a href={`/board/tasks/${run.taskId}`}>{`task #${run.taskId}`}</a>
            {` in #${run.channel}`}
          </span>
          <h1 class="title title--small">{run.title}</h1>
        </div>
        <div class="row">
          <RunChip run={run} />
          {live ? (
            <button
              class="button button--small button--secondary"
              onClick={stop}
              type="button"
            >
              Stop
            </button>
          ) : null}
        </div>
      </div>
      {error === null ? null : <div class="notice notice--bad">{error}</div>}
      {run.note === null || run.note === "" ? null : (
        <div class={run.state === "done" ? "notice" : "notice notice--warn"}>
          <Inline text={run.note} />
        </div>
      )}
      <dl class="facts">
        <dt>time</dt>
        <dd>{duration((run.endedAt ?? props.now) - run.startedAt)}</dd>
        <dt>steps</dt>
        <dd>
          {`${tools.length}${tools.some((step) => step.failed) ? `, ${tools.filter((step) => step.failed).length} failed` : ""}`}
        </dd>
        <dt>tokens</dt>
        <dd>
          {run.tokens === 0
            ? "—"
            : `${Math.round(run.tokens / THOUSAND)}k${run.cost > 0 ? ` · $${run.cost.toFixed(2)}` : ""}`}
        </dd>
        <dt>started</dt>
        <dd>{new Date(run.startedAt).toLocaleString()}</dd>
      </dl>
      <section class="card">
        <header class="card__head">
          <h2 class="card__title">Log</h2>
          <span class="hint">open a step for its output</span>
        </header>
        {steps.length === 0 ? (
          <p class="empty">
            {live ? "The sandbox starts…" : "The run has no steps."}
          </p>
        ) : (
          <ol class="steps">
            {steps.map((step, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are only added at the end.
              <StepRow key={index} step={step} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
};

/** The runs of a task, in the thread's pane. `stamp` changes when the thread does. */
export const TaskRuns = (props: {
  readonly now: number;
  readonly stamp: unknown;
  readonly taskId: string;
}) => {
  const [runs, setRuns] = useState<readonly AgentRun[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of the thread loads the runs again.
  useEffect(() => {
    get<{ runs: AgentRun[] }>(`${FACTORY}/runs`, { task: props.taskId })
      .then((answer) => setRuns(answer.runs))
      .catch(() => undefined);
  }, [props.taskId, props.stamp]);
  return runs.length === 0 ? null : (
    <div class="task-runs">
      <RunTable now={props.now} runs={runs} withAgent />
    </div>
  );
};

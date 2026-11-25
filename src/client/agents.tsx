import { useEffect, useState } from "preact/hooks";
import { del, get, post } from "./api.ts";
import {
  type Agent,
  type AgentRun,
  consumes,
  duration,
  FACTORY,
  type Overview,
  RUN_LABEL,
  type Schedule,
  useOverview,
  values,
} from "./factory.ts";
import { shortAge } from "./model.ts";
import { navigate } from "./route.ts";

/** The agents: who they are, what they can reach, and what they did. */

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
const RUNS_SHOWN = 15;
const COMMA = /\s*,\s*/;
const TRAILING_SLASH = /\/$/;

/** A group of check boxes: one for each option, checked when it is in `chosen`. */
export const Checks = (props: {
  readonly chosen: readonly string[];
  readonly empty: string;
  readonly name: string;
  readonly options: readonly string[];
}) =>
  props.options.length === 0 ? (
    <p class="hint">{props.empty}</p>
  ) : (
    <div class="checks">
      {props.options.map((option) => (
        <label class="check" key={option}>
          <input
            defaultChecked={props.chosen.includes(option)}
            name={props.name}
            type="checkbox"
            value={option}
          />
          {option}
        </label>
      ))}
    </div>
  );

export const RunChip = (props: { readonly run: AgentRun }) => (
  <span class={`chip chip--${RUN_LABEL[props.run.state].chip}`}>
    {RUN_LABEL[props.run.state].text}
  </span>
);

/** The runs of an agent or of a task, newest first. */
export const RunTable = (props: {
  readonly now: number;
  readonly runs: readonly AgentRun[];
  /** Show the agent: the runs are of one task, not of one agent. */
  readonly withAgent?: boolean;
}) => (
  <div class="table-wrap">
    <table class="table">
      <tbody>
        {props.runs.map((run) => (
          <tr key={run.id}>
            <td class="nowrap">
              <RunChip run={run} />
            </td>
            <td class="table__fill">
              <a class="run-title truncate" href={`/runs/${run.id}`}>
                {props.withAgent === true
                  ? `${run.agent} · open the log`
                  : run.title}
              </a>
            </td>
            {props.withAgent === true ? null : (
              <td class="nowrap">
                <a class="mono small" href={`/board/tasks/${run.taskId}`}>
                  {`#${run.taskId}`}
                </a>
              </td>
            )}
            <td class="nowrap muted small">
              {duration((run.endedAt ?? props.now) - run.startedAt)}
            </td>
            <td class="nowrap muted small">{`${run.steps} steps`}</td>
            <td class="nowrap muted small">
              {shortAge(run.startedAt, props.now)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const status = (agent: Agent) => {
  if (!agent.enabled) {
    return { chip: "skipped", text: "off" };
  }
  const [live] = agent.live;
  if (live !== undefined) {
    return {
      chip: "running",
      text:
        agent.live.length === 1
          ? `on #${live.taskId}`
          : `${agent.live.length} tasks`,
    };
  }
  return { chip: "queued", text: "idle" };
};

const AgentList = (props: {
  readonly agents: readonly Agent[];
  readonly selected: string | null;
}) => (
  <nav aria-label="Agents" class="list">
    {props.agents.map((agent) => {
      const now = status(agent);
      return (
        <a
          aria-current={agent.name === props.selected ? "page" : undefined}
          class="list__item"
          href={`/agents/${agent.name}`}
          key={agent.name}
        >
          <span class="list__name">{agent.name}</span>
          <span class={`chip chip--${now.chip}`}>{now.text}</span>
          <span class="list__note truncate">
            {agent.description || "no role yet"}
          </span>
        </a>
      );
    })}
    <a
      aria-current={props.selected === "new" ? "page" : undefined}
      class="list__item list__item--new"
      href="/agents/new"
    >
      + New agent
    </a>
  </nav>
);

interface Row extends Schedule {
  readonly key: number;
}

const zoneHere = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The schedules of an agent: each makes a task for the agent at its times. */
const Schedules = (props: {
  readonly agent: Agent | null;
  readonly channels: readonly string[];
  readonly onRun: (index: number) => void;
}) => {
  const [rows, setRows] = useState<Row[]>(() =>
    (props.agent?.schedules ?? []).map((schedule, key) => ({
      ...schedule,
      key,
    }))
  );
  const add = () =>
    setRows((now) => [
      ...now,
      {
        channel: props.agent?.channels[0]?.replace(TRAILING_SLASH, "") ?? "",
        cron: "0 8 * * *",
        key: Date.now(),
        text: "",
        zone: zoneHere(),
      },
    ]);
  const remove = (event: MouseEvent) => {
    const key = Number((event.currentTarget as HTMLButtonElement).value);
    setRows((now) => now.filter((row) => row.key !== key));
  };
  const run = (event: MouseEvent) =>
    props.onRun(Number((event.currentTarget as HTMLButtonElement).value));
  return (
    <div class="stack stack--sm">
      {rows.length === 0 ? (
        <p class="hint">
          No schedule. The agent works only when a task comes to its channels.
        </p>
      ) : null}
      {rows.map((row, index) => {
        const next = props.agent?.next[row.key] ?? null;
        const saved = row.key < (props.agent?.schedules.length ?? 0);
        return (
          <div class="schedule" key={row.key}>
            <label class="field">
              <span class="label">When (cron)</span>
              <input
                class="input mono"
                defaultValue={row.cron}
                name="schedule.cron"
                placeholder="0 8 * * *"
                required
              />
            </label>
            <label class="field">
              <span class="label">Time zone</span>
              <input
                class="input"
                defaultValue={row.zone}
                name="schedule.zone"
                required
              />
            </label>
            <label class="field">
              <span class="label">Task in channel</span>
              <input
                class="input"
                defaultValue={row.channel}
                list="channels"
                name="schedule.channel"
                placeholder="ops/checks"
                required
              />
            </label>
            <label class="field schedule__text">
              <span class="label">The task: a title, then the details</span>
              <textarea
                class="textarea"
                defaultValue={row.text}
                name="schedule.text"
                placeholder={
                  "Check the logs of production for new errors\nLook at the last hour. Make a task in #pipes/dev for each new error."
                }
                required
              />
            </label>
            <div class="schedule__end">
              {saved ? (
                <>
                  <span class="hint">
                    {next === null
                      ? "no next run"
                      : `next ${new Date(next).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`}
                  </span>
                  <button
                    class="button button--small button--secondary"
                    onClick={run}
                    type="button"
                    value={index}
                  >
                    Run now
                  </button>
                </>
              ) : (
                <span class="hint">save the agent to start it</span>
              )}
              <button
                aria-label="Remove the schedule"
                class="button button--small button--secondary"
                onClick={remove}
                type="button"
                value={row.key}
              >
                Remove
              </button>
            </div>
          </div>
        );
      })}
      <div>
        <button
          class="button button--small button--secondary"
          onClick={add}
          type="button"
        >
          + Add a schedule
        </button>
      </div>
      <datalist id="channels">
        {props.channels.map((channel) => (
          <option key={channel} value={channel} />
        ))}
      </datalist>
    </div>
  );
};

const Section = (props: {
  readonly children: preact.ComponentChildren;
  readonly hint: string;
  readonly title: string;
}) => (
  <section class="card">
    <header class="card__head">
      <h2 class="card__title">{props.title}</h2>
      <span class="hint truncate">{props.hint}</span>
    </header>
    <div class="card__body stack">{props.children}</div>
  </section>
);

/** The form's values as an agent. */
const agentOf = (form: FormData) => {
  const all = (name: string) => form.getAll(name).map(String);
  const crons = all("schedule.cron");
  const zones = all("schedule.zone");
  const channels = all("schedule.channel");
  const texts = all("schedule.text");
  return {
    channels: [
      ...values(form, "channels"),
      ...String(form.get("patterns") ?? "")
        .split(COMMA)
        .filter((pattern) => pattern !== ""),
    ],
    description: String(form.get("description") ?? ""),
    enabled: form.has("enabled"),
    image: String(form.get("image") ?? "").trim(),
    instructions: String(form.get("instructions") ?? ""),
    maxTurns: Number(form.get("maxTurns")),
    model: String(form.get("model") ?? ""),
    name: String(form.get("name") ?? "").trim(),
    parallel: Number(form.get("parallel")),
    projects: values(form, "projects"),
    resources: values(form, "resources"),
    schedules: crons.map((cron, index) => ({
      channel: (channels[index] ?? "").trim(),
      cron: cron.trim(),
      text: (texts[index] ?? "").trim(),
      zone: (zones[index] ?? "").trim(),
    })),
    secrets: values(form, "secrets"),
    skills: values(form, "skills"),
    thinking: String(form.get("thinking") ?? ""),
  };
};

interface SectionProps {
  readonly agent: Agent | null;
  readonly overview: Overview;
}

const RoleSection = (props: Pick<SectionProps, "agent">) => {
  const { agent } = props;
  return (
    <Section hint="Who it is and how it must work" title="Role">
      <div class="fields">
        <label class="field">
          <span class="label">Name</span>
          <input
            class="input mono"
            defaultValue={agent?.name ?? ""}
            name="name"
            pattern="[a-z0-9][a-z0-9\-]*"
            placeholder="sre"
            readOnly={agent !== null}
            required
          />
        </label>
        <label class="field fields__wide">
          <span class="label">Role, in one line</span>
          <input
            class="input"
            defaultValue={agent?.description ?? ""}
            name="description"
            placeholder="Reads the logs of production and reports new errors."
          />
        </label>
      </div>
      <label class="field">
        <span class="label">Instructions</span>
        <textarea
          class="textarea"
          defaultValue={agent?.instructions ?? ""}
          name="instructions"
          placeholder={
            "What it must do with a task, step by step.\nWhere it must hand the work on: “make a task in #pipes/dev for each new error”."
          }
        />
      </label>
      <label class="check">
        <input
          defaultChecked={agent?.enabled ?? true}
          name="enabled"
          type="checkbox"
        />
        It takes tasks and runs its schedules
      </label>
    </Section>
  );
};

const SandboxSection = (props: SectionProps) => {
  const { agent, overview } = props;
  return (
    <Section hint="What its tools can reach" title="Sandbox">
      <div class="fields">
        <div class="field">
          <span class="label">Repositories</span>
          <Checks
            chosen={agent?.projects ?? []}
            empty="No project yet. Add one in Setup."
            name="projects"
            options={overview.projects.map((project) => project.name)}
          />
        </div>
        <div class="field">
          <span class="label">Shared resources</span>
          <Checks
            chosen={agent?.resources ?? []}
            empty="No shared resource yet. Add one in Setup."
            name="resources"
            options={overview.resources.map((resource) => resource.name)}
          />
        </div>
        <div class="field">
          <span class="label">Secrets, as environment variables</span>
          <Checks
            chosen={agent?.secrets ?? []}
            empty="No secret yet. Add one in Setup."
            name="secrets"
            options={overview.secrets}
          />
        </div>
      </div>
      <label class="field">
        <span class="label">Container image</span>
        <input
          class="input mono"
          defaultValue={agent?.image ?? ""}
          name="image"
          placeholder={`${overview.image}  (Factory's own: git, curl, ripgrep, jq)`}
        />
      </label>
    </Section>
  );
};

const ModelSection = (props: SectionProps) => {
  const { agent, overview } = props;
  const models =
    agent === null ||
    agent.model === "" ||
    overview.models.includes(agent.model)
      ? overview.models
      : [agent.model, ...overview.models];
  return (
    <Section
      hint="The brain: it runs in Factory, not in the sandbox"
      title="Model"
    >
      <div class="fields">
        <label class="field fields__wide">
          <span class="label">Model</span>
          <select class="select" name="model">
            <option value="">Choose a model…</option>
            {models.map((model) => (
              <option
                key={model}
                selected={model === agent?.model}
                value={model}
              >
                {model}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span class="label">Thinking</span>
          <select class="select" name="thinking">
            {THINKING.map((level) => (
              <option
                key={level}
                selected={level === (agent?.thinking ?? "medium")}
                value={level}
              >
                {level}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span class="label">Most tool rounds</span>
          <input
            class="input"
            defaultValue={String(agent?.maxTurns ?? 80)}
            min="1"
            name="maxTurns"
            type="number"
          />
        </label>
        <label class="field">
          <span class="label">Tasks at one time</span>
          <input
            class="input"
            defaultValue={String(agent?.parallel ?? 1)}
            min="1"
            name="parallel"
            type="number"
          />
        </label>
      </div>
      {overview.models.length === 0 ? (
        <div class="notice notice--warn">
          No model has credentials. Add a secret with the provider's key
          (ANTHROPIC_API_KEY, OPENAI_API_KEY) in Setup, or log in with Pi on
          this computer.
        </div>
      ) : null}
    </Section>
  );
};

const AgentEditor = (props: {
  readonly agent: Agent | null;
  readonly now: number;
  readonly onChange: () => void;
  readonly overview: Overview;
}) => {
  const { agent, overview } = props;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [sure, setSure] = useState(false);
  const [runs, setRuns] = useState<readonly AgentRun[]>([]);
  const name = agent?.name ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the overview comes again every few seconds, and the runs with it.
  useEffect(() => {
    if (name !== null) {
      get<{ runs: AgentRun[] }>(`${FACTORY}/runs`, {
        agent: name,
        limit: RUNS_SHOWN,
      })
        .then((answer) => setRuns(answer.runs))
        .catch(() => undefined);
    }
  }, [name, overview]);
  const write = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      props.onChange();
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    }
  };
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const next = agentOf(new FormData(event.currentTarget as HTMLFormElement));
    if (await write(() => post(`${FACTORY}/agents`, next))) {
      setSaved(true);
      navigate(`/agents/${next.name}`);
    }
  };
  const edited = () => setSaved(false);
  const remove = async () => {
    if (!sure) {
      setSure(true);
      return;
    }
    if (await write(() => del(`${FACTORY}/agents/${name}`))) {
      navigate("/agents");
    }
  };
  const runNow = (index: number) =>
    write(() => post(`${FACTORY}/agents/${name}/schedules/${index}`));
  // Channels that the agent has and the board does not (a prefix such as `pipes/`) stay as text.
  const patterns = (agent?.channels ?? []).filter(
    (channel) => !overview.channels.includes(channel)
  );
  return (
    <form class="stack" onInput={edited} onSubmit={save}>
      <div class="page-head page-head--tight">
        <div>
          <span class="eyebrow">Agent</span>
          <h1 class="title title--small">{agent?.name ?? "New agent"}</h1>
        </div>
        <div class="row">
          {saved ? <span class="hint">Saved.</span> : null}
          {agent === null ? null : (
            <button
              class="button button--small button--secondary"
              onClick={remove}
              type="button"
            >
              {sure ? "Really delete it?" : "Delete"}
            </button>
          )}
          <button class="button button--primary" type="submit">
            Save
          </button>
        </div>
      </div>
      {error === null ? null : <div class="notice notice--bad">{error}</div>}
      <RoleSection agent={agent} />
      <Section hint="The tasks of these channels are its work" title="Channels">
        <Checks
          chosen={agent?.channels ?? []}
          empty="The board has no channel yet. Make one on the board, or write a name below."
          name="channels"
          options={overview.channels}
        />
        <label class="field">
          <span class="label">More channels, with commas</span>
          <input
            class="input mono"
            defaultValue={patterns.join(", ")}
            name="patterns"
            placeholder="pipes/  (pipes and all channels below it)"
          />
        </label>
      </Section>
      <Section hint="Each makes a task for this agent" title="Schedules">
        <Schedules agent={agent} channels={overview.channels} onRun={runNow} />
      </Section>
      <SandboxSection agent={agent} overview={overview} />
      <Section
        hint="Skills in a repository's .agents/skills are found without a setting"
        title="Skills"
      >
        <Checks
          chosen={agent?.skills ?? []}
          empty="No skill yet. Write or upload one in Setup."
          name="skills"
          options={overview.skills.map((skill) => skill.name)}
        />
      </Section>
      <ModelSection agent={agent} overview={overview} />
      {agent === null ? null : (
        <section class="card">
          <header class="card__head">
            <h2 class="card__title">Runs</h2>
            <span class="hint">the newest first; open one for its log</span>
          </header>
          {runs.length === 0 ? (
            <p class="empty">It did no task yet.</p>
          ) : (
            <RunTable now={props.now} runs={runs} />
          )}
        </section>
      )}
    </form>
  );
};

/** The agents that do the tasks of a channel, in the channel's head on the board. */
export const ChannelAgents = (props: { readonly channel: string }) => {
  const [agents, setAgents] = useState<readonly Agent[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new channel can be the first sight of a new agent.
  useEffect(() => {
    get<Overview>(FACTORY)
      .then((overview) => setAgents(overview.agents))
      .catch(() => undefined);
  }, [props.channel]);
  if (agents === null) {
    return null;
  }
  const here = agents.filter(
    (agent) => agent.enabled && consumes(agent, props.channel)
  );
  return (
    <span class="col-head__agents">
      {here.length === 0 ? (
        <a
          class="col-head__assign"
          href="/agents"
          title="No agent does the tasks of this channel. Give the channel to an agent."
        >
          + agent
        </a>
      ) : (
        here.map((agent) => (
          <a
            href={`/agents/${agent.name}`}
            key={agent.name}
            title={`${agent.name} does the tasks of this channel${agent.description === "" ? "" : `: ${agent.description}`}`}
          >
            {agent.name}
          </a>
        ))
      )}
    </span>
  );
};

export const AgentsPage = (props: {
  /** The agent in the address, `new`, or null. */
  readonly name: string | null;
  readonly now: number;
}) => {
  const { data, error, reload } = useOverview();
  if (data === null) {
    return <p class="empty">{error ?? "Loading…"}</p>;
  }
  const selected = props.name ?? data.agents[0]?.name ?? "new";
  const agent = data.agents.find((one) => one.name === selected) ?? null;
  return (
    <div class="fpage split">
      <AgentList agents={data.agents} selected={selected} />
      <AgentEditor
        agent={agent}
        key={selected}
        now={props.now}
        onChange={reload}
        overview={data}
      />
    </div>
  );
};

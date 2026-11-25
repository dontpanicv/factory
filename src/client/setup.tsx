import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { Checks } from "./agents.tsx";
import { del, post } from "./api.ts";
import {
  FACTORY,
  type Overview,
  type Project,
  type Resource,
  type Skill,
  useOverview,
  values,
} from "./factory.ts";

/** What the agents work with: the repositories, the shared resources, the skills and the secrets. */

const TABS = [
  {
    hint: "Git repositories that sandboxes check out",
    id: "projects",
    title: "Projects",
  },
  {
    hint: "Containers that sandboxes can reach",
    id: "resources",
    title: "Shared resources",
  },
  { hint: "Instructions for one kind of work", id: "skills", title: "Skills" },
  {
    hint: "Credentials for sandboxes and models",
    id: "secrets",
    title: "Secrets",
  },
] as const;
type Tab = (typeof TABS)[number]["id"];

const RESOURCE_CHIP: Record<string, string> = {
  exited: "failed",
  running: "passed",
  stopped: "skipped",
  unknown: "waiting",
};

/** The agents that use a definition, as a note in its row. */
const usedBy = (
  overview: Overview,
  kind: "projects" | "resources" | "secrets" | "skills",
  name: string
) => {
  const agents = overview.agents
    .filter((agent) => agent[kind].includes(name))
    .map((agent) => agent.name);
  return agents.length === 0 ? "no agent" : agents.join(", ");
};

/** A list of definitions with a form for the one that is open. */
const Editor = (props: {
  readonly children: ComponentChildren;
  readonly empty: string;
  readonly error: string | null;
  readonly onSubmit: (event: SubmitEvent) => void;
  readonly open: string | null;
  readonly rows: ComponentChildren;
  readonly title: string;
}) => (
  <div class="editor">
    <section class="card">
      {props.rows === null ? (
        <p class="empty">{props.empty}</p>
      ) : (
        <div class="table-wrap">
          <table class="table">
            <tbody>{props.rows}</tbody>
          </table>
        </div>
      )}
    </section>
    <form class="card" key={props.open ?? "new"} onSubmit={props.onSubmit}>
      <header class="card__head">
        <h2 class="card__title">
          {props.open === null ? `New ${props.title}` : props.open}
        </h2>
      </header>
      <div class="card__body stack">
        {props.error === null ? null : (
          <div class="notice notice--bad">{props.error}</div>
        )}
        {props.children}
        <div class="row">
          <button class="button button--primary" type="submit">
            Save
          </button>
        </div>
      </div>
    </form>
  </div>
);

interface TextProps {
  readonly area?: boolean;
  readonly hint?: string;
  readonly label: string;
  readonly mono?: boolean;
  readonly name: string;
  readonly placeholder?: string;
  readonly readOnly?: boolean;
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly value: string;
}

/** The control of a field: a text area, or an input that shows or hides its value. */
const Control = (props: TextProps) => {
  if (props.area === true) {
    return (
      <textarea
        class="textarea"
        defaultValue={props.value}
        name={props.name}
        placeholder={props.placeholder}
      />
    );
  }
  return props.secret === true ? (
    <input
      autoComplete="off"
      class="input"
      defaultValue={props.value}
      name={props.name}
      required={props.required}
      type="password"
    />
  ) : (
    <input
      autoComplete="off"
      class={props.mono === true ? "input mono" : "input"}
      defaultValue={props.value}
      name={props.name}
      placeholder={props.placeholder}
      readOnly={props.readOnly}
      required={props.required}
      type="text"
    />
  );
};

const Text = (props: TextProps) => (
  // biome-ignore lint/a11y/noLabelWithoutControl: `Control` is the control.
  <label class="field">
    <span class="label">{props.label}</span>
    <Control {...props} />
    {props.hint === undefined ? null : <span class="hint">{props.hint}</span>}
  </label>
);

const NAME_HINT = "small letters, digits and -";

/** The state and the handlers that each tab needs: the open row, the error, save and delete. */
const useEditor = (kind: Tab, reload: () => void) => {
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const write = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      reload();
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    }
  };
  const pick = (event: MouseEvent) => {
    const { value } = event.currentTarget as HTMLButtonElement;
    setOpen(value === "" ? null : value);
    setError(null);
  };
  const remove = async (event: MouseEvent) => {
    const { value } = event.currentTarget as HTMLButtonElement;
    if (await write(() => del(`${FACTORY}/${kind}/${value}`))) {
      setOpen(null);
    }
  };
  const save = async (body: { readonly name: string }) => {
    if (await write(() => post(`${FACTORY}/${kind}`, body))) {
      setOpen(kind === "secrets" ? null : body.name);
    }
  };
  return { error, open, pick, remove, save, write };
};

const RowActions = (props: {
  readonly name: string;
  readonly onPick: (event: MouseEvent) => void;
  readonly onRemove: (event: MouseEvent) => void;
  readonly pick?: boolean;
}) => (
  <td class="nowrap row-actions">
    {props.pick === false ? null : (
      <button
        class="button button--small button--secondary"
        onClick={props.onPick}
        type="button"
        value={props.name}
      >
        Edit
      </button>
    )}
    <button
      class="button button--small button--secondary"
      onClick={props.onRemove}
      type="button"
      value={props.name}
    >
      Delete
    </button>
  </td>
);

const NewButton = (props: {
  readonly onPick: (event: MouseEvent) => void;
  readonly open: string | null;
  readonly title: string;
}) =>
  props.open === null ? null : (
    <tr>
      <td colSpan={4}>
        <button
          class="button button--small button--secondary"
          onClick={props.onPick}
          type="button"
          value=""
        >
          {`+ New ${props.title}`}
        </button>
      </td>
    </tr>
  );

const Projects = (props: {
  readonly overview: Overview;
  readonly reload: () => void;
}) => {
  const { overview } = props;
  const editor = useEditor("projects", props.reload);
  const project: Project | undefined = overview.projects.find(
    (one) => one.name === editor.open
  );
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    editor.save({
      branch: String(form.get("branch") || "main"),
      name: String(form.get("name")),
      setup: String(form.get("setup") ?? ""),
      tokenSecret: String(form.get("tokenSecret") ?? ""),
      url: String(form.get("url")),
    } as Project);
  };
  return (
    <Editor
      empty="No project yet. A project is a Git repository that agents work on."
      error={editor.error}
      onSubmit={submit}
      open={editor.open}
      rows={
        overview.projects.length === 0 ? null : (
          <>
            {overview.projects.map((one) => (
              <tr key={one.name}>
                <td class="mono nowrap">{one.name}</td>
                <td class="table__fill">
                  <span class="muted small truncate">{`${one.url} · ${one.branch}`}</span>
                </td>
                <td class="nowrap muted small">
                  {usedBy(overview, "projects", one.name)}
                </td>
                <RowActions
                  name={one.name}
                  onPick={editor.pick}
                  onRemove={editor.remove}
                />
              </tr>
            ))}
            <NewButton
              onPick={editor.pick}
              open={editor.open}
              title="project"
            />
          </>
        )
      }
      title="project"
    >
      <Text
        hint={`The directory in the sandbox: /workspace/<name>. Use ${NAME_HINT}.`}
        label="Name"
        mono
        name="name"
        placeholder="pipes"
        readOnly={project !== undefined}
        required
        value={project?.name ?? ""}
      />
      <Text
        label="Git URL"
        mono
        name="url"
        placeholder="https://github.com/acme/pipes.git"
        required
        value={project?.url ?? ""}
      />
      <Text
        label="Branch"
        mono
        name="branch"
        placeholder="main"
        value={project?.branch ?? "main"}
      />
      <label class="field">
        <span class="label">Token</span>
        <select class="select" name="tokenSecret">
          <option value="">None: a public repository, read only</option>
          {overview.secrets.map((secret) => (
            <option
              key={secret}
              selected={secret === project?.tokenSecret}
              value={secret}
            >
              {secret}
            </option>
          ))}
        </select>
        <span class="hint">
          A secret with a token that can read and push. Git in the sandbox uses
          it.
        </span>
      </label>
      <Text
        area
        label="Setup, after the checkout"
        name="setup"
        placeholder="bun install"
        value={project?.setup ?? ""}
      />
    </Editor>
  );
};

const Resources = (props: {
  readonly overview: Overview;
  readonly reload: () => void;
}) => {
  const { overview } = props;
  const editor = useEditor("resources", props.reload);
  const resource: Resource | undefined = overview.resources.find(
    (one) => one.name === editor.open
  );
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    editor.save({
      command: String(form.get("command") ?? ""),
      description: String(form.get("description") ?? ""),
      env: String(form.get("env") ?? ""),
      image: String(form.get("image")),
      name: String(form.get("name")),
      secrets: values(form, "secrets"),
    } as unknown as Resource);
  };
  const power = (event: MouseEvent) => {
    const button = event.currentTarget as HTMLButtonElement;
    editor.write(() =>
      post(`${FACTORY}/resources/${button.name}/${button.value}`)
    );
  };
  return (
    <Editor
      empty="No shared resource yet. A shared resource is a container that runs one time for all sandboxes: PostgreSQL, Elasticsearch, an OIDC server."
      error={editor.error}
      onSubmit={submit}
      open={editor.open}
      rows={
        overview.resources.length === 0 ? null : (
          <>
            {overview.resources.map((one) => (
              <tr key={one.name}>
                <td class="mono nowrap">{one.name}</td>
                <td class="nowrap">
                  <span
                    class={`chip chip--${RESOURCE_CHIP[one.state] ?? "waiting"}`}
                  >
                    {one.state}
                  </span>
                </td>
                <td class="table__fill">
                  <span class="muted small truncate">
                    {`${one.image} · ${usedBy(overview, "resources", one.name)}`}
                  </span>
                </td>
                <td class="nowrap row-actions">
                  <button
                    class="button button--small button--secondary"
                    name={one.name}
                    onClick={power}
                    type="button"
                    value={one.state === "running" ? "stop" : "start"}
                  >
                    {one.state === "running" ? "Stop" : "Start"}
                  </button>
                  <button
                    class="button button--small button--secondary"
                    onClick={editor.pick}
                    type="button"
                    value={one.name}
                  >
                    Edit
                  </button>
                  <button
                    class="button button--small button--secondary"
                    onClick={editor.remove}
                    type="button"
                    value={one.name}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            <NewButton
              onPick={editor.pick}
              open={editor.open}
              title="shared resource"
            />
          </>
        )
      }
      title="shared resource"
    >
      <Text
        hint={`Also its host name in the sandboxes that can reach it. Use ${NAME_HINT}.`}
        label="Name"
        mono
        name="name"
        placeholder="postgres"
        readOnly={resource !== undefined}
        required
        value={resource?.name ?? ""}
      />
      <Text
        label="Container image"
        mono
        name="image"
        placeholder="postgres:17"
        required
        value={resource?.image ?? ""}
      />
      <Text
        hint="Agents read this: say what it is for and how to connect."
        label="Description"
        name="description"
        placeholder="The test database. User postgres, port 5432."
        value={resource?.description ?? ""}
      />
      <Text
        area
        label="Environment, KEY=value lines"
        name="env"
        placeholder="POSTGRES_HOST_AUTH_METHOD=trust"
        value={resource?.env ?? ""}
      />
      <div class="field">
        <span class="label">Secrets, as environment variables</span>
        <Checks
          chosen={resource?.secrets ?? []}
          empty="No secret yet."
          name="secrets"
          options={overview.secrets}
        />
      </div>
      <Text
        hint="Empty: the command of the image. A saved change starts with the next Start."
        label="Command"
        mono
        name="command"
        value={resource?.command ?? ""}
      />
    </Editor>
  );
};

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/;
const FRONT_NAME = /^name:\s*(.*)$/m;
const FRONT_DESCRIPTION = /^description:\s*(.*)$/m;

/** The parts of a SKILL.md file: its name and description from the front matter, and the text. */
const skillOf = (text: string): Skill => {
  const [whole = "", head = ""] = text.match(FRONT_MATTER) ?? [];
  const [, description = ""] = head.match(FRONT_DESCRIPTION) ?? [];
  const [, name = ""] = head.match(FRONT_NAME) ?? [];
  return {
    body: text.slice(whole.length).trim(),
    description: description.trim(),
    name: name.trim(),
  };
};

const Skills = (props: {
  readonly overview: Overview;
  readonly reload: () => void;
}) => {
  const { overview } = props;
  const editor = useEditor("skills", props.reload);
  const [uploaded, setUploaded] = useState<Skill | null>(null);
  const skill: Skill | undefined =
    uploaded ?? overview.skills.find((one) => one.name === editor.open);
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    setUploaded(null);
    editor.save({
      body: String(form.get("body") ?? ""),
      description: String(form.get("description") ?? ""),
      name: String(form.get("name")),
    } as Skill);
  };
  const upload = async (event: Event) => {
    const [file] = (event.currentTarget as HTMLInputElement).files ?? [];
    if (file !== undefined) {
      setUploaded(skillOf(await file.text()));
    }
  };
  return (
    <Editor
      empty="No skill yet. A skill tells an agent how to do one kind of work. Agents read a skill when a task needs it."
      error={editor.error}
      onSubmit={submit}
      open={uploaded === null ? editor.open : `upload:${uploaded.name}`}
      rows={
        overview.skills.length === 0 ? null : (
          <>
            {overview.skills.map((one) => (
              <tr key={one.name}>
                <td class="mono nowrap">{one.name}</td>
                <td class="table__fill">
                  <span class="muted small truncate">{one.description}</span>
                </td>
                <td class="nowrap muted small">
                  {usedBy(overview, "skills", one.name)}
                </td>
                <RowActions
                  name={one.name}
                  onPick={editor.pick}
                  onRemove={editor.remove}
                />
              </tr>
            ))}
            <NewButton onPick={editor.pick} open={editor.open} title="skill" />
          </>
        )
      }
      title="skill"
    >
      <label class="field">
        <span class="label">Upload a SKILL.md</span>
        <input
          accept=".md,text/markdown,text/plain"
          class="input"
          onChange={upload}
          type="file"
        />
      </label>
      <Text
        hint={`Use ${NAME_HINT}.`}
        label="Name"
        mono
        name="name"
        placeholder="triage-errors"
        required
        value={skill?.name ?? ""}
      />
      <Text
        hint="Agents see only this line until they open the skill: say when to use it."
        label="Description"
        name="description"
        placeholder="How to triage a new error from the logs. Use it for each alert."
        value={skill?.description ?? ""}
      />
      <Text
        area
        label="Instructions"
        name="body"
        placeholder={"1. Find the first time of the error.\n2. …"}
        value={skill?.body ?? ""}
      />
    </Editor>
  );
};

const Secrets = (props: {
  readonly overview: Overview;
  readonly reload: () => void;
}) => {
  const { overview } = props;
  const editor = useEditor("secrets", props.reload);
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    editor.save({
      name: String(data.get("name")),
      value: String(data.get("value")),
    } as { name: string });
    form.reset();
  };
  return (
    <Editor
      empty="No secret yet."
      error={editor.error}
      onSubmit={submit}
      open={null}
      rows={
        overview.secrets.length === 0
          ? null
          : overview.secrets.map((name) => (
              <tr key={name}>
                <td class="mono nowrap">{name}</td>
                <td class="table__fill muted small">
                  {usedBy(overview, "secrets", name)}
                </td>
                <RowActions
                  name={name}
                  onPick={editor.pick}
                  onRemove={editor.remove}
                  pick={false}
                />
              </tr>
            ))
      }
      title="secret"
    >
      <Text
        hint="The name of the environment variable. A secret with a name that exists replaces it."
        label="Name"
        mono
        name="name"
        placeholder="GITHUB_TOKEN"
        required
        value=""
      />
      <Text label="Value" name="value" required secret value="" />
      <p class="hint">
        Factory shows a value to no one. A sandbox gets a secret only when its
        agent has it. A provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY) also
        gives the agents that provider's models.
      </p>
    </Editor>
  );
};

const PANELS = {
  projects: Projects,
  resources: Resources,
  secrets: Secrets,
  skills: Skills,
};

export const SetupPage = (props: { readonly tab: string | null }) => {
  const { data, error, reload } = useOverview();
  if (data === null) {
    return <p class="empty">{error ?? "Loading…"}</p>;
  }
  const tab = TABS.find((one) => one.id === props.tab) ?? TABS[0];
  const Panel = PANELS[tab.id];
  return (
    <div class="fpage stack">
      <div class="page-head page-head--tight">
        <div>
          <span class="eyebrow">Setup</span>
          <h1 class="title title--small">{tab.title}</h1>
        </div>
        <nav aria-label="Setup" class="switch">
          {TABS.map((one) => (
            <a
              aria-current={one.id === tab.id ? "page" : undefined}
              href={`/setup/${one.id}`}
              key={one.id}
              title={one.hint}
            >
              {one.title}
            </a>
          ))}
        </nav>
      </div>
      <Panel key={tab.id} overview={data} reload={reload} />
    </div>
  );
};

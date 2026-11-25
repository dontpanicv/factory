import {
  Editor,
  NAME_HINT,
  NewButton,
  RowActions,
  Text,
  usedBy,
  useEditor,
} from "../../shared/client/editor.tsx";
import type { Overview, Project } from "../../shared/client/overview.ts";
import { Select } from "../../shared/client/select.tsx";

/** The Projects tab of Setup: the Git repositories that agents work on. */

export const Projects = (props: {
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
      <div class="field">
        <span class="label">Token</span>
        <Select
          label="Token"
          name="tokenSecret"
          options={[
            { label: "None: a public repository, read only", value: "" },
            ...overview.secrets.map((secret) => ({
              label: secret,
              value: secret,
            })),
          ]}
          value={project?.tokenSecret ?? ""}
        />
        <span class="hint">
          A secret with a token that can read and push. Git in the sandbox uses
          it.
        </span>
      </div>
      <Text
        area
        label="Setup, after the checkout"
        name="setup"
        placeholder="bun install"
        short
        value={project?.setup ?? ""}
      />
    </Editor>
  );
};

import {
  Editor,
  RowActions,
  Text,
  usedBy,
  useEditor,
} from "../../shared/client/editor.tsx";
import type { Overview } from "../../shared/client/overview.ts";

/** The Secrets tab of Setup: credentials for sandboxes and models. */

export const Secrets = (props: {
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

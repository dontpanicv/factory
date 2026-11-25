import { useState } from "preact/hooks";
import {
  Editor,
  NAME_HINT,
  NewButton,
  RowActions,
  Text,
  usedBy,
  useEditor,
} from "../../shared/client/editor.tsx";
import type { Overview, Skill } from "../../shared/client/overview.ts";

/** The Skills tab of Setup: instructions for one kind of work. */

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

export const Skills = (props: {
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

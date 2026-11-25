import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { del, post } from "./api.ts";
import { FACTORY, type Overview } from "./overview.ts";

/** The parts of a page that edits definitions: a list of them, and a form for the one that is open. */

/** The values of the checked boxes and the filled inputs with this name. */
export const values = (form: FormData, name: string) =>
  form
    .getAll(name)
    .map((value) => String(value).trim())
    .filter((value) => value !== "");

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

/** The agents that use a definition, as a note in its row. */
export const usedBy = (
  overview: Overview,
  kind: "projects" | "resources" | "secrets" | "skills",
  name: string
) => {
  const agents = overview.agents
    .filter((agent) => agent[kind].includes(name))
    .map((agent) => agent.name);
  return agents.length === 0 ? "not used" : `used by ${agents.join(", ")}`;
};

/** A list of definitions with a form for the one that is open. */
export const Editor = (props: {
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
  /** A text area for a few lines. */
  readonly short?: boolean;
  readonly value: string;
}

/** The control of a field: a text area, or an input that shows or hides its value. */
const Control = (props: TextProps) => {
  if (props.area === true) {
    return (
      <textarea
        class={props.short === true ? "textarea textarea--short" : "textarea"}
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

export const Text = (props: TextProps) => (
  // biome-ignore lint/a11y/noLabelWithoutControl: `Control` is the control.
  <label class="field">
    <span class="label">{props.label}</span>
    <Control {...props} />
    {props.hint === undefined ? null : <span class="hint">{props.hint}</span>}
  </label>
);

export const NAME_HINT = "small letters, digits and -";

/** The state and the handlers that each tab needs: the open row, the error, save and delete. */
export const useEditor = (kind: string, reload: () => void) => {
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

export const RowActions = (props: {
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

export const NewButton = (props: {
  readonly onPick: (event: MouseEvent) => void;
  readonly open: string | null;
  readonly title: string;
}) =>
  props.open === null ? null : (
    <tr class="table__foot">
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

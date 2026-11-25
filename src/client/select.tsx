import { useEffect, useRef, useState } from "preact/hooks";
import { Check, ChevronDown } from "./icons.tsx";

/**
 * Factory's own dropdown and suggestion list, in place of the browser's: they look the same in each
 * browser and follow the Factory design. Both work with the keyboard.
 */

export interface Option {
  readonly label: string;
  readonly value: string;
}

/** The most rows of a menu that show without a scroll. */
const MENU_ROOM = 300;

/** The row that the arrow keys move to: it stays in the list. */
const step = (key: string, active: number, count: number) => {
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return count - 1;
  }
  const next = active + (key === "ArrowDown" ? 1 : -1);
  return Math.max(0, Math.min(count - 1, next));
};

const MOVES = new Set(["ArrowDown", "ArrowUp", "End", "Home"]);

/**
 * A dropdown with one value. A hidden input holds the value, so a form reads it by `name` as it
 * reads a `<select>`.
 */
export const Select = (props: {
  /** What the dropdown sets, for a screen reader. */
  readonly label: string;
  readonly name: string;
  readonly options: readonly Option[];
  readonly value: string;
}) => {
  const [value, setValue] = useState(props.value);
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const selected = props.options.findIndex((option) => option.value === value);
  useEffect(() => {
    if (!open) {
      return;
    }
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const show = () => {
    const box = root.current?.getBoundingClientRect();
    // The menu opens above the field when the window has no room below it.
    setAbove(box !== undefined && box.bottom + MENU_ROOM > window.innerHeight);
    setActive(Math.max(0, selected));
    setOpen(true);
  };
  const choose = (next: string) => {
    setValue(next);
    setOpen(false);
    // The form hears a change, as from its other fields.
    root.current?.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const toggle = () => (open ? setOpen(false) : show());
  const pick = (event: MouseEvent) =>
    choose((event.currentTarget as HTMLButtonElement).value);
  const keys = (event: KeyboardEvent) => {
    if (MOVES.has(event.key)) {
      event.preventDefault();
      if (open) {
        setActive(step(event.key, active, props.options.length));
      } else {
        show();
      }
    } else if (open && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      choose(props.options[active]?.value ?? value);
    } else if (open && (event.key === "Escape" || event.key === "Tab")) {
      setOpen(false);
    }
  };
  return (
    <div class="dropdown" ref={root}>
      <input name={props.name} type="hidden" value={value} />
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={props.label}
        class="dropdown__trigger"
        onClick={toggle}
        onKeyDown={keys}
        type="button"
      >
        <span class="truncate">{props.options[selected]?.label ?? value}</span>
        <span class="caret">
          <ChevronDown />
        </span>
      </button>
      {open ? (
        <div class={above ? "menu menu--above" : "menu"} role="listbox">
          {props.options.map((option, index) => (
            <button
              aria-selected={option.value === value}
              class="menu__item"
              data-active={index === active ? "" : undefined}
              key={option.value}
              onClick={pick}
              role="option"
              tabIndex={-1}
              type="button"
              value={option.value}
            >
              <span class="menu__mark">
                {option.value === value ? <Check /> : null}
              </span>
              <span class="truncate">{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

interface Suggested {
  readonly active: number;
  readonly input: HTMLInputElement;
  readonly options: readonly string[];
  /** Where the list is in the window, as CSS: below the input, or above it when there is no room. */
  readonly place: Readonly<Record<string, string>>;
}

/** The height of one row of the list, and of the list's own border and padding. */
const ROW = 36;
const FRAME = 12;

const SUGGESTIONS_MAX = 8;

/** The suggestions of an input for what it holds now: those of its `<datalist>` that have its text. */
const suggestionsOf = (input: HTMLInputElement): Suggested | null => {
  const list = document.getElementById(input.dataset.suggest ?? "");
  if (!(list instanceof HTMLDataListElement)) {
    return null;
  }
  const text = input.value.trim().toLowerCase();
  const options = [...list.options]
    .map((option) => option.value)
    .filter(
      (option) =>
        option.toLowerCase().includes(text) && option.toLowerCase() !== text
    )
    .slice(0, SUGGESTIONS_MAX);
  if (options.length === 0) {
    return null;
  }
  // An input in a field with a prefix: the list lines up with the field, not with the text.
  const box = (
    input.closest(".composer__field") ?? input
  ).getBoundingClientRect();
  const side = { left: `${box.left}px`, width: `${box.width}px` };
  const above = box.bottom + options.length * ROW + FRAME > window.innerHeight;
  return {
    active: -1,
    input,
    options,
    place: above
      ? { ...side, bottom: `${window.innerHeight - box.top}px` }
      : { ...side, top: `${box.bottom}px` },
  };
};

/** Write to an input as a person does: its form and its handlers hear it. */
const write = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

/**
 * The suggestion list of each input with `data-suggest="<id of a datalist>"`. One list for the
 * page: it opens below the input that has the focus. An arrow key picks a row, Enter takes it.
 */
export const Suggestions = () => {
  const [state, setState] = useState<Suggested | null>(null);
  const current = useRef<Suggested | null>(null);
  current.current = state;
  useEffect(() => {
    const open = (event: Event) => {
      const { target } = event;
      setState(
        target instanceof HTMLInputElement && target.dataset.suggest
          ? suggestionsOf(target)
          : null
      );
    };
    const close = () => setState(null);
    const keys = (event: KeyboardEvent) => {
      const now = current.current;
      if (now === null) {
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = now.active + (event.key === "ArrowDown" ? 1 : -1);
        setState({
          ...now,
          active: Math.max(-1, Math.min(now.options.length - 1, next)),
        });
      } else if (event.key === "Enter" && now.active >= 0) {
        // The row is taken; the Enter does not also send the form.
        event.preventDefault();
        event.stopPropagation();
        write(now.input, now.options[now.active] ?? now.input.value);
        setState(null);
      } else if (event.key === "Escape") {
        event.stopPropagation();
        setState(null);
      }
    };
    document.addEventListener("focusin", open);
    document.addEventListener("input", open);
    document.addEventListener("focusout", close);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", keys, true);
    return () => {
      document.removeEventListener("focusin", open);
      document.removeEventListener("input", open);
      document.removeEventListener("focusout", close);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", keys, true);
    };
  }, []);
  // A press on a row must not take the focus from the input: the list would close first.
  const hold = (event: MouseEvent) => event.preventDefault();
  const pick = (event: MouseEvent) => {
    if (state !== null) {
      write(state.input, (event.currentTarget as HTMLButtonElement).value);
      setState(null);
    }
  };
  return state === null ? null : (
    <div class="menu menu--fixed" role="listbox" style={state.place}>
      {state.options.map((option, index) => (
        <button
          aria-selected={index === state.active}
          class="menu__item"
          data-active={index === state.active ? "" : undefined}
          key={option}
          onClick={pick}
          onMouseDown={hold}
          role="option"
          tabIndex={-1}
          type="button"
          value={option}
        >
          <span class="truncate">{option}</span>
        </button>
      ))}
    </div>
  );
};
